import { contactEvent, providerIdentity } from '@/db/schema'
import {
	evergreenOfferJourneyCommit as commits,
	evergreenOfferJourneyIntent as intents,
} from '@/db/evergreen-offer-journey-schema'
import { eq } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import type { VerifiedCouponOwnerQuery } from './coupon-authority'
import {
	couponBindingIntentKey,
	parseJourneyId,
	parseVerifiedUserId,
} from './primitives'
import {
	restorePersistedDomainEvents,
	restorePersistedTransitionReceipt,
	restorePersistedSideEffectIntent,
	validatePersistedCommitEvidenceEnvelope,
} from './persistence-codec'
import {
	EVERGREEN_OFFER_JOURNEY_COMMIT_FORMAT,
	EVERGREEN_OFFER_JOURNEY_INTENT_FORMAT,
} from './persistence-contract'
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
// Narrow SELECT-only store. No current User/Contact/ContactLink queries: those
// identities must be passed from the coupon transaction's locked rows.
export interface VerifiedOwnerEvidenceReadStore {
	readonly intent: (key: string) => Promise<typeof intents.$inferSelect | null>
	readonly commit: (
		stimulusId: string,
	) => Promise<typeof commits.$inferSelect | null>
	readonly event: (
		id: string,
	) => Promise<typeof contactEvent.$inferSelect | null>
	readonly identity: (
		id: string,
	) => Promise<typeof providerIdentity.$inferSelect | null>
}
export function createMySqlVerifiedOwnerEvidenceReadStore(
	database: Pick<MySql2Database, 'select'>,
): VerifiedOwnerEvidenceReadStore {
	return {
		intent: async (key) =>
			(
				await database
					.select()
					.from(intents)
					.where(eq(intents.idempotencyKey, key))
					.limit(1)
			)[0] ?? null,
		commit: async (id) =>
			(
				await database
					.select()
					.from(commits)
					.where(eq(commits.stimulusId, id))
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
	// Strict JSON comparison independent of key order, including unexpected keys.
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
		// Claim key includes attestation ID, which is not known here. Resolve via
		// deterministic BindCoupon PK -> originating commit -> exact source PK.
		const intentKey = couponBindingIntentKey({
			journeyId: journey.value,
			verifiedUserId: user.value,
		})
		const intentRow = await read(() => options.store.intent(intentKey))
		if (
			!intentRow ||
			intentRow.format !== EVERGREEN_OFFER_JOURNEY_INTENT_FORMAT ||
			intentRow.idempotencyKey !== intentKey ||
			intentRow.journeyId !== input.journeyId ||
			intentRow.intentType !== 'BindCoupon'
		)
			return null
		const intent = restorePersistedSideEffectIntent(intentRow.intent)
		if (
			!intent.ok ||
			intent.value.type !== 'BindCoupon' ||
			intent.value.idempotencyKey !== intentKey ||
			intent.value.journeyId !== input.journeyId ||
			intent.value.contactId !== input.contactId ||
			intent.value.verifiedUserId !== input.verifiedUserId ||
			intent.value.couponId !== input.couponId
		)
			return null
		const commit = await read(() =>
			options.store.commit(intentRow.originatingStimulusId),
		)
		if (
			!commit ||
			commit.format !== EVERGREEN_OFFER_JOURNEY_COMMIT_FORMAT ||
			commit.stimulusId !== intentRow.originatingStimulusId ||
			commit.journeyId !== input.journeyId ||
			commit.actorVersion !== intentRow.actorVersion ||
			!Number.isFinite(commit.decidedAt.getTime())
		)
			return null
		const restored = validatePersistedCommitEvidenceEnvelope(
			commit.commitEvidence,
			{
				stimulusId: commit.stimulusId,
				stimulusType: commit.stimulusType,
				journeyId: commit.journeyId,
				actorVersion: commit.actorVersion,
				decidedAt: commit.decidedAt.toISOString(),
			},
		)
		if (
			!restored.ok ||
			restored.value.stimulus.type !== 'VerifiedUserObserved' ||
			restored.value.currentFacts.contactId !== input.contactId ||
			restored.value.currentFacts.existingJourneyId !== input.journeyId ||
			intentRow.ordinal !== 0 ||
			commit.committedAt.getTime() !== commit.decidedAt.getTime() ||
			intentRow.createdAt.getTime() !== commit.decidedAt.getTime() ||
			intentRow.availableAt.getTime() !== commit.decidedAt.getTime()
		)
			return null
		const events = restorePersistedDomainEvents(commit.events)
		const receipt = restorePersistedTransitionReceipt(commit.receipt)
		if (
			!events.ok ||
			events.value.length !== 1 ||
			!receipt.ok ||
			receipt.value.stimulusId !== commit.stimulusId ||
			receipt.value.journeyId !== input.journeyId ||
			receipt.value.committedAt !== commit.decidedAt.toISOString() ||
			!['pitch.running', 'handoff.awaitingReceipt'].includes(
				receipt.value.from,
			) ||
			receipt.value.from !== receipt.value.to
		)
			return null
		const bound = events.value[0]
		if (
			!bound ||
			bound.type !== 'CouponBindingIntentCommitted' ||
			bound.details.couponId !== input.couponId ||
			bound.details.verifiedUserId !== input.verifiedUserId ||
			bound.details.intentKey !== intentKey ||
			bound.occurredAt !== receipt.value.committedAt
		)
			return null
		const stimulus = restored.value.stimulus
		if (
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
		for (const [row, eventType, semanticKey, at] of [
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
				row.contactId !== input.contactId ||
				row.provider !== 'ai-hero' ||
				row.schemaVersion !== 1 ||
				row.eventType !== eventType ||
				row.semanticIdempotencyKey !== semanticKey ||
				row.providerEventId !== semanticKey ||
				row.providerReference !== `ai-hero:${semanticKey}` ||
				row.privacyLevel !== 'restricted' ||
				!sameIdentityEnvelope(row.identityEvidence, expectedIdentity) ||
				row.occurredAt.getTime() !== Math.floor(Date.parse(at) / 1000) * 1000
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
				claimObserved <= commit.decidedAt.getTime() &&
				commit.decidedAt.getTime() <= now
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
