import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { and, eq, getTableName, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
	contact,
	users,
	sessions,
	providerIdentity,
	contactEvent,
} from '@/db/schema'
import type {
	EmailLoginCapture,
	EmailObservationResult,
} from '@/server/verified-email-observation'
import type { EvergreenOfferJourneyDatabase } from './drizzle-ledger'
import type { EmailObservationTransactions } from './email-observation-transaction'
import {
	emailFingerprint,
	emailTokenHash,
	sessionTokenHash,
	loginSemanticKey,
	emailTokenLoginObservedSchema,
	emailTokenLoginEventRow,
	resolveOwnerContact,
	type EmailTokenLoginObservedPayload,
	type OwnerProviderIdentity,
} from './verified-owner-evidence'

const instant = z.string().refine((value) => {
	const date = new Date(value)
	return Number.isFinite(date.getTime()) && date.toISOString() === value
})
export const emailObservationInputSchema = z
	.object({
		userId: z.string().min(1).max(255),
		email: z.string().trim().toLowerCase().email().max(255),
		verifiedAt: instant,
		acceptedToken: z.string().min(1).max(2048),
		sessionToken: z.string().min(1).max(255),
		sessionExpires: instant,
	})
	.strict()
/** Narrow dormant native-MySQL implementation. A Vitess-compatible path needs
 * separate proven serialization, not an assumed MySQL version string. */
export function supportsEmailObservationSerialization(
	version: string,
	engines: readonly string[],
) {
	return (
		// Necessary sanity checks only: a proxy can report a plain version too.
		// Unknown decorations hold, including vendor/community/log suffixes.
		/^8\.(0|4)\.\d+$/.test(version) &&
		engines.length === 5 &&
		engines.every((e) => e === 'InnoDB')
	)
}
type Database = Pick<EvergreenOfferJourneyDatabase, 'select' | 'execute'>
type Reason =
	| 'InvalidCapture'
	| 'SerializationUnavailable'
	| 'ContactUnavailable'
	| 'IdentityUnavailable'
	| 'VerificationChanged'
	| 'SessionUnavailable'
	| 'ConflictingReplay'
	| 'ReadbackUnavailable'
	| 'StoreUnavailable'
export type EmailObservationWriteResult = EmailObservationResult & {
	readonly reason?: Reason
}
class ObservationHold extends Error {
	constructor(readonly reason: Reason) {
		super(reason)
	}
}
function hold(reason: Reason): never {
	throw new ObservationHold(reason)
}
type Expected = {
	payload: EmailTokenLoginObservedPayload
	identity: OwnerProviderIdentity
	id: string
}
const eventId = (key: string) =>
	`elog_${createHash('sha256').update(key).digest('hex')}`

/** No default client, secret or production registration. Both handles must be
 * independent primary/autocommit pools. All raw auth input remains ephemeral. */
export function createEmailTokenLoginObservationWriter(options: {
	database: Database
	transactions: EmailObservationTransactions
	readbackDatabase: Pick<Database, 'select'>
	secret: string
	now: () => Date
}) {
	const db = options.database
	const clock = () => {
		const now = options.now()
		if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
			return hold('InvalidCapture')
		return now
	}
	return async (
		input: EmailLoginCapture,
	): Promise<EmailObservationWriteResult> => {
		let expected: Expected | undefined
		try {
			if (!options.secret || options.database === options.readbackDatabase)
				return hold('StoreUnavailable')
			const parsed = emailObservationInputSchema.safeParse(input)
			if (!parsed.success) return hold('InvalidCapture')
			const capture = parsed.data
			const tokenHash = emailTokenHash(options.secret, capture.acceptedToken)
			const sessionHash = sessionTokenHash(options.secret, capture.sessionToken)
			const fingerprint = emailFingerprint(options.secret, capture.email)
			// Actual engine/version reads precede the transaction. Table metadata and
			// successful SET TRANSACTION are necessary checks, not production readiness.
			const [versionRows] = await db.execute(sql`SELECT VERSION() AS version`)
			const versions = z
				.array(z.object({ version: z.string() }))
				.parse(versionRows)
			const names = [
				contact,
				users,
				sessions,
				providerIdentity,
				contactEvent,
			].map(getTableName)
			const [engineRows] = await db.execute(
				sql`SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${sql.join(
					names.map((name) => sql`${name}`),
					sql`, `,
				)})`,
			)
			const engines = z
				.array(z.object({ engine: z.string() }))
				.parse(engineRows)
			if (
				versions.length !== 1 ||
				!supportsEmailObservationSerialization(
					versions[0]!.version,
					engines.map((e) => e.engine),
				)
			)
				return hold('SerializationUnavailable')
			try {
				await options.transactions.run(async (tx) => {
					// Compare normalized candidates BEFORE LIMIT 2: raw equality misses
					// case/whitespace duplicates under binary collations. ICU whitespace
					// plus BOM covers JS trim; JS rechecking below rejects false matches.
					// Result count is bounded, not scan cost. Native serializable locking
					// can cover broad scanned ranges. Production cost/compatibility is
					// unproved; this writer remains unbound and disabled in auth.
					const candidates = await tx
						.select({ id: contact.id, email: contact.email })
						.from(contact)
						.where(
							sql`lower(regexp_replace(${contact.email}, ${'^[\\s\\x{FEFF}]+|[\\s\\x{FEFF}]+$'}, '')) = ${capture.email}`,
						)
						.limit(2)
						.for('update')
					if (candidates.length !== 1) return hold('ContactUnavailable')
					const owner = candidates[0]!
					if (owner.email?.trim().toLowerCase() !== capture.email)
						return hold('ContactUnavailable')
					const [currentUser] = await tx
						.select({
							id: users.id,
							email: users.email,
							emailVerified: users.emailVerified,
						})
						.from(users)
						.where(eq(users.id, capture.userId))
						.limit(1)
						.for('update')
					if (
						!currentUser ||
						currentUser.email?.trim().toLowerCase() !== capture.email ||
						currentUser.emailVerified?.toISOString() !== capture.verifiedAt
					)
						return hold('VerificationChanged')
					const [currentSession] = await tx
						.select({ userId: sessions.userId, expires: sessions.expires })
						.from(sessions)
						.where(eq(sessions.sessionToken, capture.sessionToken))
						.limit(1)
						.for('update')
					if (
						!currentSession ||
						currentSession.userId !== capture.userId ||
						currentSession.expires <= clock()
					)
						return hold('SessionUnavailable')
					const identities = await tx
						.select({
							id: providerIdentity.id,
							contactId: providerIdentity.contactId,
							provider: providerIdentity.provider,
							externalId: providerIdentity.externalId,
						})
						.from(providerIdentity)
						.where(
							and(
								eq(providerIdentity.contactId, owner.id),
								eq(providerIdentity.provider, 'kit'),
							),
						)
						.limit(2)
						.for('update')
					if (identities.length !== 1) return hold('IdentityUnavailable')
					const identity = identities[0]!
					if (identity.contactId !== owner.id || identity.provider !== 'kit')
						return hold('IdentityUnavailable')
					const observedAt = clock().toISOString()
					if (
						capture.verifiedAt > observedAt ||
						currentSession.expires <= new Date(observedAt)
					)
						return hold('VerificationChanged')
					const payload = emailTokenLoginObservedSchema.parse({
						version: 1,
						userId: capture.userId,
						contactId: owner.id,
						emailFingerprint: fingerprint,
						verifiedAt: capture.verifiedAt,
						sessionTokenHash: sessionHash,
						tokenHash,
						mechanism: 'auth-email-callback',
						observedAt,
					})
					const selected: OwnerProviderIdentity = {
						...identity,
						provider: 'kit',
					}
					const id = eventId(loginSemanticKey(payload))
					const row = emailTokenLoginEventRow({
						id,
						payload,
						identity: selected,
						resolution: resolveOwnerContact(
							candidates.map((c) => c.id),
							owner.id,
						),
					})
					expected = { id, payload, identity: selected }
					await tx.insert(contactEvent).values(row)
				})
			} catch (error) {
				// A validation failure cannot borrow an earlier receipt. Only an attempted
				// INSERT/COMMIT (including duplicate or unknown acknowledgment) may verify.
				if (!expected) throw error
			}
			if (!expected) return hold('StoreUnavailable')
			const proposed: Expected = expected
			// Independent committed read, outside the writer transaction, exactly once.
			const [saved] = await options.readbackDatabase
				.select()
				.from(contactEvent)
				.where(eq(contactEvent.id, proposed.id))
				.limit(1)
			if (!saved) return hold('ReadbackUnavailable')
			const stored = emailTokenLoginObservedSchema.safeParse(
				saved.payloadSummary,
			)
			if (!stored.success) return hold('ConflictingReplay')
			if (
				!isDeepStrictEqual(
					{ ...stored.data, observedAt: '' },
					{ ...proposed.payload, observedAt: '' },
				) ||
				stored.data.observedAt < stored.data.verifiedAt ||
				stored.data.observedAt > clock().toISOString()
			)
				return hold('ConflictingReplay')
			// Rebuild from the ORIGINAL stored observation time, never overwrite it.
			const canonical = emailTokenLoginEventRow({
				id: proposed.id,
				payload: stored.data,
				identity: proposed.identity,
				resolution: resolveOwnerContact(
					[stored.data.contactId],
					stored.data.contactId,
				),
			})
			for (const key of Object.keys(canonical) as (keyof typeof canonical)[]) {
				if (!isDeepStrictEqual(saved[key], canonical[key]))
					return hold('ConflictingReplay')
			}
			if (
				!(saved.createdAt instanceof Date) ||
				!Number.isFinite(saved.createdAt.getTime())
			)
				return hold('ConflictingReplay')
			return { type: 'Recorded' }
		} catch (error) {
			const reason =
				error instanceof ObservationHold ? error.reason : 'StoreUnavailable'
			return {
				type: reason === 'ConflictingReplay' ? 'Conflict' : 'Unavailable',
				reason,
			}
		}
	}
}
