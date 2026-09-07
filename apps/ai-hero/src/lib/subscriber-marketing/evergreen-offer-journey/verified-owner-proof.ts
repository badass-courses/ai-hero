import { contactEvent, providerIdentity } from '@/db/schema'
import { evergreenOfferJourneyIntent as intents } from '@/db/evergreen-offer-journey-schema'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import type { VerifiedCouponOwnerQuery } from './coupon-authority'
import {
	couponBindingIntentKey,
	parseJourneyId,
	parseVerifiedUserId,
} from './primitives'
import {
	readCanonicalIntentOrigin,
	type EvergreenOfferJourneyDatabase,
} from './drizzle-ledger'
import {
	EMAIL_TOKEN_LOGIN_OBSERVED,
	OFFER_CLAIM_OBSERVED,
	claimEventIdFromReference,
	claimSemanticKey,
	claimSourceReference,
	emailFingerprint,
	emailTokenLoginObservedSchema,
	loginSemanticKey,
	offerClaimObservedSchema,
	ownerIdentityEvidence,
} from './verified-owner-evidence'

export class VerifiedOwnerProofUnavailable extends Error {
	readonly _tag = 'VerifiedOwnerProofUnavailable'
	constructor() {
		super('Verified owner evidence read unavailable')
	}
}
export type VerifiedOwnerProof = {
	readonly type: 'VerifiedUserObserved'
	readonly contactId: string
	readonly journeyId: string
	readonly verifiedUserId: string
	readonly observedAt: string
	readonly sourceReference: string
}
// No current User/Contact/ContactLink queries: those identities are supplied by
// the coupon transaction's locked rows. Canonical history uses the owning ledger
// query contract, not a substitute validator or a caller-asserted proof object.
export interface VerifiedOwnerEvidenceReadStore {
	readonly canonical: Parameters<typeof readCanonicalIntentOrigin>[0]
	readonly intent: (key: string) => Promise<typeof intents.$inferSelect | null>
	readonly event: (
		id: string,
	) => Promise<typeof contactEvent.$inferSelect | null>
	readonly identity: (
		id: string,
	) => Promise<typeof providerIdentity.$inferSelect | null>
}
export function createMySqlVerifiedOwnerEvidenceReadStore(
	database: EvergreenOfferJourneyDatabase,
): VerifiedOwnerEvidenceReadStore {
	return {
		canonical: database,
		intent: async (key) =>
			(
				await database
					.select()
					.from(intents)
					.where(eq(intents.idempotencyKey, key))
					.limit(1)
			)[0] ?? null,
		event: async (id) =>
			(
				await database
					.select()
					.from(contactEvent)
					.where(eq(contactEvent.id, id))
					.limit(1)
			)[0] ?? null,
		identity: async (id) =>
			(
				await database
					.select()
					.from(providerIdentity)
					.where(eq(providerIdentity.id, id))
					.limit(1)
			)[0] ?? null,
	}
}
function sameIdentityEnvelope(actual: unknown, expected: unknown): boolean {
	const sorted = (input: unknown): string =>
		JSON.stringify(input, (_key, value: unknown) =>
			value && typeof value === 'object' && !Array.isArray(value)
				? Object.fromEntries(
						Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
					)
				: value,
		)
	return sorted(actual) === sorted(expected)
}

/** Dormant. Trusted producers own immutable evidence; fixtures are not auth.
 * Missing/malformed/conflicting proof returns null. Read failures throw the
 * typed unavailable error, translated by coupon authority to transient failure.
 */
export function createVerifiedOwnerProofReader(options: {
	readonly store: VerifiedOwnerEvidenceReadStore
	readonly secret: string
	readonly now: () => string
}) {
	if (!options.secret)
		throw new Error('Owner proof fingerprint secret required')
	return async (
		input: VerifiedCouponOwnerQuery,
	): Promise<VerifiedOwnerProof | null> => {
		const read = async <A>(work: () => Promise<A>): Promise<A> => {
			try {
				return await work()
			} catch {
				throw new VerifiedOwnerProofUnavailable()
			}
		}
		const now = Date.parse(await read(async () => options.now()))
		if (!Number.isFinite(now)) throw new VerifiedOwnerProofUnavailable()
		const journey = parseJourneyId(input.journeyId)
		const user = parseVerifiedUserId(input.verifiedUserId)
		if (
			!journey.ok ||
			!user.ok ||
			input.lockedContact.id !== input.contactId ||
			input.lockedUser.id !== input.verifiedUserId ||
			!input.lockedContact.email ||
			!input.lockedUser.email.trim() ||
			!input.lockedContact.email.trim() ||
			!input.lockedUser.emailVerified
		)
			return null
		const intentKey = couponBindingIntentKey({
			journeyId: journey.value,
			verifiedUserId: user.value,
		})
		const row = await read(() => options.store.intent(intentKey))
		if (!row || row.idempotencyKey !== intentKey) return null
		// Same restoration/recomputation used by durable attempt admission: exact
		// saved decision, snapshots, predecessor, normalized records and receipts.
		// The ledger makes indexed origin/predecessor/version queries; no locking,
		// recursive proof callbacks or whole-history first-match scans.
		const restored = await read(() =>
			Effect.runPromise(
				Effect.either(readCanonicalIntentOrigin(options.store.canonical, row)),
			),
		)
		if (restored._tag === 'Left') {
			if (restored.left.type === 'JourneyDecodeFailure') return null
			throw new VerifiedOwnerProofUnavailable()
		}
		const { intent, stimulus, decidedAt } = restored.right
		if (
			intent.type !== 'BindCoupon' ||
			intent.idempotencyKey !== intentKey ||
			intent.journeyId !== input.journeyId ||
			intent.contactId !== input.contactId ||
			intent.verifiedUserId !== input.verifiedUserId ||
			intent.couponId !== input.couponId ||
			stimulus.type !== 'VerifiedUserObserved' ||
			stimulus.verifiedUserId !== input.verifiedUserId ||
			stimulus.journeyId !== input.journeyId
		)
			return null
		const eventId = claimEventIdFromReference(stimulus.sourceReference)
		if (!eventId || stimulus.stimulusId !== eventId) return null
		const claimRow = await read(() => options.store.event(eventId))
		if (!claimRow || claimRow.id !== eventId) return null
		const claim = offerClaimObservedSchema.safeParse(claimRow.payloadSummary)
		if (
			!claim.success ||
			claim.data.contactId !== input.contactId ||
			claim.data.journeyId !== input.journeyId ||
			claim.data.verifiedUserId !== input.verifiedUserId ||
			claim.data.observedAt !== stimulus.observedAt
		)
			return null
		const loginRow = await read(() =>
			options.store.event(claim.data.attestationEventId),
		)
		if (!loginRow || loginRow.id !== claim.data.attestationEventId) return null
		const login = emailTokenLoginObservedSchema.safeParse(
			loginRow.payloadSummary,
		)
		if (
			!login.success ||
			login.data.contactId !== input.contactId ||
			login.data.userId !== input.verifiedUserId ||
			login.data.sessionTokenHash !== claim.data.sessionTokenHash ||
			login.data.emailFingerprint !== claim.data.emailFingerprint ||
			login.data.verifiedAt !== claim.data.verifiedAt
		)
			return null
		if (loginRow.providerIdentityId !== claimRow.providerIdentityId) return null
		const identity = await read(() =>
			options.store.identity(claimRow.providerIdentityId),
		)
		if (
			!identity ||
			identity.id !== claimRow.providerIdentityId ||
			identity.contactId !== input.contactId ||
			identity.provider !== 'kit' ||
			!identity.externalId ||
			identity.externalId.length > 255 ||
			/[\s\u0000-\u001f]/.test(identity.externalId)
		)
			return null
		const expectedIdentity = ownerIdentityEvidence({
			...identity,
			provider: 'kit',
		})
		for (const [event, eventType, semanticKey, at] of [
			[
				claimRow,
				OFFER_CLAIM_OBSERVED,
				claimSemanticKey(claim.data),
				claim.data.observedAt,
			],
			[
				loginRow,
				EMAIL_TOKEN_LOGIN_OBSERVED,
				loginSemanticKey(login.data),
				login.data.observedAt,
			],
		] as const) {
			if (
				event.contactId !== input.contactId ||
				event.provider !== 'ai-hero' ||
				event.schemaVersion !== 1 ||
				event.eventType !== eventType ||
				event.semanticIdempotencyKey !== semanticKey ||
				event.providerEventId !== semanticKey ||
				event.providerReference !== `ai-hero:${semanticKey}` ||
				event.privacyLevel !== 'restricted' ||
				!sameIdentityEnvelope(event.identityEvidence, expectedIdentity) ||
				event.occurredAt.getTime() !== Math.floor(Date.parse(at) / 1000) * 1000
			)
				return null
		}
		const verified = Date.parse(login.data.verifiedAt)
		const loginObserved = Date.parse(login.data.observedAt)
		const claimObserved = Date.parse(claim.data.observedAt)
		if (
			Date.parse(input.lockedUser.emailVerified) !== verified ||
			!(
				verified <= loginObserved &&
				loginObserved <= claimObserved &&
				claimObserved <= Date.parse(decidedAt) &&
				Date.parse(decidedAt) <= now
			) ||
			login.data.emailFingerprint !==
				emailFingerprint(options.secret, input.lockedUser.email) ||
			login.data.emailFingerprint !==
				emailFingerprint(options.secret, input.lockedContact.email)
		)
			return null
		return {
			type: 'VerifiedUserObserved',
			contactId: input.contactId,
			journeyId: input.journeyId,
			verifiedUserId: input.verifiedUserId,
			observedAt: claim.data.observedAt,
			sourceReference: claimSourceReference(eventId),
		}
	}
}
