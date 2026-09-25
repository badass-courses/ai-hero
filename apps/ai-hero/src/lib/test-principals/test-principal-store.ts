import { and, eq, getTableColumns, is, like, lt, lte, sql } from 'drizzle-orm'
import {
	getTableConfig,
	MySqlTable,
	type MySqlColumn,
	type MySqlDatabase,
} from 'drizzle-orm/mysql-core'

import * as schema from '@/db/schema'
import {
	contact,
	contactState,
	contentRead,
	coupon,
	signupAttribution,
	users,
	verificationTokens,
} from '@/db/schema'
import {
	SYNTHETIC_PRINCIPAL_EMAIL_DOMAIN,
	SYNTHETIC_PRINCIPAL_ID_LIKE,
} from '@/lib/synthetic-principal'
import { contactEmailWriteValues } from '@/lib/subscriber-marketing/contact-email-equivalence'
import { evergreenJourneyIdForContact } from '@/lib/subscriber-marketing/drovr-evergreen-coupon'
import { semanticCouponId } from '@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority'
import { couponIntentKey } from '@/lib/subscriber-marketing/evergreen-offer-journey/primitives'
import { CONTACT_STATE_SCHEMA_VERSION } from '@/lib/subscriber-marketing/types'

import {
	MAGIC_LINK_REUSE_WINDOW_MS,
	MAX_LIVE_TEST_PRINCIPALS,
	TEST_PRINCIPAL_TTL_MS,
	testPrincipalIdentity,
	type TestPrincipalIdentity,
} from './test-principal'

// Every delete and lookup carries a second, independent guard: the row's key
// must itself be synthetic.
const SYNTHETIC_ID_LIKE = SYNTHETIC_PRINCIPAL_ID_LIKE
const SYNTHETIC_EMAIL_LIKE = `%@${SYNTHETIC_PRINCIPAL_EMAIL_DOMAIN}`

// Any drizzle MySQL database: the app's pool or a disposable test database.
type Database = MySqlDatabase<any, any, any>

/** A table keyed to a principal by one of these columns. */
type KeyedTable = {
	name: string
	table: MySqlTable
	column: 'userId' | 'contactId'
	key: MySqlColumn
	/** The schema declares an index (or primary key) led by this column. */
	indexed: boolean
}

/**
 * Keyed columns prod has no index on (information_schema, 2026-09-25). A
 * delete keyed on one scans the whole table, which blew PlanetScale's 20s
 * transaction limit on AI_ContentRead (~1M rows), so each has its own way.
 */
export const UNINDEXED_KEY_CLEANUP = {
	// Signed-in reads key their unique semanticIdempotencyKey on the user id.
	'AI_ContentRead.userId': 'content-read-semantic-key',
	// Written for a purchase only, and checkout is refused for a synthetic user.
	'AI_MerchantCharge.userId': 'never-written',
	// Written for a purchase or a Kit subscribe only; both refused here.
	'AI_ShortlinkAttribution.userId': 'never-written',
} as const satisfies Record<string, 'content-read-semantic-key' | 'never-written'>

/** Indexed in prod outside the Drizzle schema (idx_OrganizationMembership_on_userId). */
const PROD_ONLY_INDEXED_KEYS = new Set(['AI_OrganizationMembership.userId'])

/**
 * Every app table with a userId or contactId column, read from the schema
 * itself so a table added later is cleaned without anyone remembering to.
 */
export function principalKeyedTables(): KeyedTable[] {
	const keyed: KeyedTable[] = []
	for (const value of Object.values(schema)) {
		if (!is(value, MySqlTable)) continue
		const columns: Record<string, MySqlColumn | undefined> =
			getTableColumns(value)
		const name = tableName(value)
		const config = getTableConfig(value)
		const leading = new Set<string>([
			...config.indexes.map(
				(index) => (index.config.columns[0] as { name?: string } | undefined)?.name ?? '',
			),
			...config.primaryKeys.map((pk) => pk.columns[0]?.name ?? ''),
			...Object.values(columns)
				.filter((column) => column?.primary || column?.isUnique)
				.map((column) => column!.name),
		])
		for (const column of ['userId', 'contactId'] as const) {
			const key = columns[column]
			if (key) {
				keyed.push({
					name,
					table: value,
					column,
					key,
					indexed:
						leading.has(key.name) || PROD_ONLY_INDEXED_KEYS.has(`${name}.${column}`),
				})
			}
		}
	}
	return keyed
}

function tableName(table: MySqlTable): string {
	return (table as unknown as Record<symbol, string>)[
		Symbol.for('drizzle:Name')
	]!
}

function affected(result: unknown): number {
	return Number((result as { rowsAffected?: number }).rowsAffected ?? 0)
}

export type MintedPrincipalRecords =
	| {
			status: 'minted' | 'existing'
			identity: TestPrincipalIdentity
			createdAt: Date
			expiresAt: Date
	  }
	| { status: 'limit'; live: number }

/**
 * Create (or reuse, within its hour) the principal for a runId and replace
 * its one outstanding sign-in token. Direct inserts: no Auth.js createUser
 * event, so nothing reaches USER_CREATED, Kit, or organization provisioning.
 */
export async function mintTestPrincipalRecords(
	database: Database,
	args: { runId: string; now: Date; tokenHash: string; tokenExpires: Date },
): Promise<MintedPrincipalRecords> {
	const identity = testPrincipalIdentity(args.runId)
	return retryOnMintConflict(() =>
		database.transaction(async (tx) => {
			// One locking read over the synthetic id range is both the lookup and
			// the live count. Its next-key locks make concurrent mints (same runId
			// or not) wait for each other, so the cap and the insert are atomic; a
			// deadlock or duplicate key from a race retries the whole mint.
			const principals = await tx
				.select({ id: users.id, createdAt: users.createdAt })
				.from(users)
				.where(like(users.id, SYNTHETIC_ID_LIKE))
				.for('update')
			const existing = principals.find((row) => row.id === identity.principalId)
			const liveSince = new Date(args.now.getTime() - TEST_PRINCIPAL_TTL_MS)
			const isLive = (row: { createdAt: Date | null }) =>
				row.createdAt != null && row.createdAt > liveSince
			const reusable = existing != null && isLive(existing)
			let createdAt: Date
			if (reusable) {
				createdAt = existing.createdAt!
			} else {
				// An expired principal for this runId starts over, never extends.
				if (existing) await deletePrincipalRows(tx, identity)
				const liveCount = principals.filter(isLive).length
				if (liveCount >= MAX_LIVE_TEST_PRINCIPALS) {
					return { status: 'limit', live: liveCount } as const
				}
				createdAt = args.now
				await tx.insert(users).values({
					id: identity.principalId,
					email: identity.email,
					name: `Link test ${args.runId}`,
					emailVerified: args.now,
					createdAt: args.now,
				})
				await tx.insert(contact).values({
					id: identity.contactId,
					userId: identity.principalId,
					...contactEmailWriteValues(identity.email),
					lifecycle: 'new',
					isProvisional: true,
					createdAt: args.now,
					updatedAt: args.now,
				})
				// Personalize reads the contact's state; without one every emailKey
				// comes back stale-state with no variables. Shaped like a real
				// signup's (human-review, low confidence) and marked synthetic.
				await tx.insert(contactState).values({
					contactId: identity.contactId,
					lifecycle: 'human-review',
					primaryBucket: 'other-unclear',
					allBuckets: ['other-unclear'],
					whySignals: [],
					whoSignals: [],
					confidence: '0',
					rationale: ['Synthetic test principal (#36T); not a real signup.'],
					reviewSignals: ['synthetic-principal'],
					humanReview: true,
					lastEventId: `test-principal:${args.runId}`,
					schemaVersion: CONTACT_STATE_SCHEMA_VERSION,
					updatedAt: args.now,
				})
			}
			await tx
				.delete(verificationTokens)
				.where(
					and(
						eq(verificationTokens.identifier, identity.email),
						like(verificationTokens.identifier, SYNTHETIC_EMAIL_LIKE),
					),
				)
			await tx.insert(verificationTokens).values({
				identifier: identity.email,
				token: args.tokenHash,
				expires: args.tokenExpires,
				// CourseBuilder's adapter keeps a magic link reusable for 90s after
				// createdAt (email scanners click first). A test principal's link is
				// one-time: start it past that window so its first use consumes it.
				createdAt: new Date(
					args.now.getTime() - MAGIC_LINK_REUSE_WINDOW_MS - 1_000,
				),
			})
			return {
				status: reusable ? 'existing' : 'minted',
				identity,
				createdAt,
				expiresAt: new Date(createdAt.getTime() + TEST_PRINCIPAL_TTL_MS),
			} as const
		}),
	)
}

/** LIKE-escape a literal (the ids carry `_`, a LIKE wildcard). */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

const mysqlErrno = (error: unknown) =>
	(error as { errno?: number }).errno ??
	(error as { cause?: { errno?: number } }).cause?.errno

/** A concurrent mint lost a race (1062 duplicate key, 1213 deadlock): retry. */
async function retryOnMintConflict<T>(run: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await run()
		} catch (error) {
			const errno = mysqlErrno(error)
			if (attempt >= 5 || (errno !== 1062 && errno !== 1213)) throw error
			await new Promise((resolve) => setTimeout(resolve, 25 * attempt))
		}
	}
}

/** The canonical id the evergreen coupon authority gives this contact's coupon. */
export function testPrincipalCouponId(identity: TestPrincipalIdentity): string {
	return semanticCouponId(
		couponIntentKey(evergreenJourneyIdForContact(identity.contactId)),
	)
}

export type PrincipalRemovalReceipt = {
	removed: Record<string, number>
	/** Schema tables this database does not have (MySQL 1146), so nothing to clean. */
	absentTables: string[]
}

const isMissingTable = (error: unknown) =>
	(error as { errno?: number; cause?: { errno?: number } }).errno === 1146 ||
	(error as { cause?: { errno?: number } }).cause?.errno === 1146

async function deletePrincipalRows(
	database: Database,
	identity: TestPrincipalIdentity,
	createdBefore?: Date,
): Promise<PrincipalRemovalReceipt> {
	const removed: Record<string, number> = {}
	const absentTables: string[] = []
	const note = (name: string, result: unknown) => {
		const rows = affected(result)
		if (rows > 0) removed[name] = (removed[name] ?? 0) + rows
	}
	// Only a missing table is tolerated; any other error stops the cleanup,
	// and the retry repeats it: every statement is idempotent.
	const attempt = async (name: string, run: () => Promise<unknown>) => {
		try {
			note(name, await run())
		} catch (error) {
			if (!isMissingTable(error)) throw error
			if (!absentTables.includes(name)) absentTables.push(name)
		}
	}
	// Children first, each its own short statement on an index: equality on
	// the principal's id, which is already proven synthetic by its User row.
	// The LIKE guard stays on the principal's own rows below.
	for (const { name, table, column, key } of principalKeyedTables()) {
		const id = column === 'userId' ? identity.principalId : identity.contactId
		const strategy =
			UNINDEXED_KEY_CLEANUP[`${name}.${column}` as keyof typeof UNINDEXED_KEY_CLEANUP]
		if (strategy === 'never-written') continue
		if (strategy === 'content-read-semantic-key') {
			await attempt(name, () =>
				database
					.delete(contentRead)
					.where(
						and(
							like(
								contentRead.semanticIdempotencyKey,
								`content-read:v1:${escapeLike(identity.principalId)}:%`,
							),
							eq(contentRead.userId, identity.principalId),
						),
					),
			)
			continue
		}
		await attempt(name, () => database.delete(table).where(eq(key, id)))
	}
	note(
		'AI_Contact',
		await database
			.delete(contact)
			.where(
				and(
					eq(contact.id, identity.contactId),
					like(contact.id, SYNTHETIC_ID_LIKE),
					...(createdBefore ? [lt(contact.createdAt, createdBefore)] : []),
				),
			),
	)
	note(
		'AI_VerificationToken',
		await database
			.delete(verificationTokens)
			.where(
				and(
					eq(verificationTokens.identifier, identity.email),
					like(verificationTokens.identifier, SYNTHETIC_EMAIL_LIKE),
				),
			),
	)
	// The run's synthetic evergreen coupon (T3c), by its canonical id, and
	// only while its issue evidence names this synthetic contact. Grants a
	// synthetic user bound are already gone with the userId tables above; a
	// real buyer's grant, if one ever existed, is never touched.
	await attempt('AI_Coupon', () =>
		database
			.delete(coupon)
			.where(
				and(
					eq(coupon.id, testPrincipalCouponId(identity)),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${coupon.fields}, '$.evergreenOffer.issue.contactId')) = ${identity.contactId}`,
					sql`JSON_UNQUOTE(JSON_EXTRACT(${coupon.fields}, '$.evergreenOffer.issue.contactId')) LIKE ${SYNTHETIC_ID_LIKE}`,
				),
			),
	)
	await attempt('AI_SignupAttribution', () =>
		database
			.delete(signupAttribution)
			.where(
				and(
					eq(signupAttribution.email, identity.email),
					like(signupAttribution.email, SYNTHETIC_EMAIL_LIKE),
				),
			),
	)
	// The principal's own row goes last, so a partial run leaves it in place
	// and a retry finds the principal and finishes.
	note(
		'AI_User',
		await database
			.delete(users)
			.where(
				and(
					eq(users.id, identity.principalId),
					like(users.id, SYNTHETIC_ID_LIKE),
					...(createdBefore ? [lt(users.createdAt, createdBefore)] : []),
				),
			),
	)
	return { removed, absentTables }
}

/**
 * Remove a principal and everything keyed to it, in one transaction.
 * Returns null when nothing was there (the caller answers 204).
 */
export async function deleteTestPrincipalRecords(
	database: Database,
	principalId: string,
	options: {
		/** The reaper's cutoff: skip a principal re-minted since it was listed. */
		createdBefore?: Date
	} = {},
): Promise<
	({ identity: TestPrincipalIdentity } & PrincipalRemovalReceipt) | null
> {
	// No wrapping transaction: PlanetScale ends one after 20s. Each statement
	// is short and index-backed, and the User row goes last.
	const [user] = await database
		.select({ email: users.email, createdAt: users.createdAt })
		.from(users)
		.where(and(eq(users.id, principalId), like(users.id, SYNTHETIC_ID_LIKE)))
	if (!user?.email) return null
	if (
		options.createdBefore &&
		(user.createdAt == null || user.createdAt >= options.createdBefore)
	)
		return null
	// The address carries the runId; rebuild the identity from it.
	const runId = user.email.slice(0, user.email.indexOf('@'))
	const identity = testPrincipalIdentity(runId)
	if (identity.principalId !== principalId) return null
	return {
		identity,
		...(await deletePrincipalRows(database, identity, options.createdBefore)),
	}
}

/** Principals older than their hour, oldest first, for the reaper. */
export async function expiredTestPrincipalIds(
	database: Database,
	args: { now: Date; limit: number },
): Promise<string[]> {
	const rows = await database
		.select({ id: users.id })
		.from(users)
		.where(
			and(
				like(users.id, SYNTHETIC_ID_LIKE),
				lte(
					users.createdAt,
					new Date(args.now.getTime() - TEST_PRINCIPAL_TTL_MS),
				),
			),
		)
		.orderBy(users.createdAt)
		.limit(args.limit)
	return rows.map((row) => row.id)
}
