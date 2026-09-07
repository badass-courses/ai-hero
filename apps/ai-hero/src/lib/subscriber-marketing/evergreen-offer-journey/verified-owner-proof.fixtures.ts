import type { contactEvent, providerIdentity } from '@/db/schema'
import type {
	evergreenOfferJourneyCommit,
	evergreenOfferJourneyIntent,
} from '@/db/evergreen-offer-journey-schema'
import type { VerifiedCouponOwnerQuery } from './coupon-authority'
import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import {
	EVERGREEN_OFFER_JOURNEY_COMMIT_FORMAT,
	EVERGREEN_OFFER_JOURNEY_INTENT_FORMAT,
} from './persistence-contract'
import { EVERGREEN_OFFER_JOURNEY_COMMIT_EVIDENCE_FORMAT } from './persistence-codec'
import {
	couponBindingIntentKey,
	parseJourneyId,
	parseVerifiedUserId,
} from './primitives'
import {
	emailFingerprint,
	emailTokenHash,
	sessionTokenHash,
	emailTokenLoginEventRow,
	resolveOwnerContact,
	offerClaimEventRow,
	claimSourceReference,
	type EmailTokenLoginObservedPayload,
	type OfferClaimObservedPayload,
} from './verified-owner-evidence'
import type { VerifiedOwnerEvidenceReadStore } from './verified-owner-proof'

// Synthetic contract fixtures only. Nothing here is a production evidence writer.
export function ownerProofFixture() {
	const secret = 'synthetic-fixture-secret'
	const verifiedAt = '2026-09-10T16:00:00.123Z'
	const loginObserved = '2026-09-10T16:00:01.234Z'
	const claimObserved = '2026-09-10T16:00:02.345Z'
	const committedAt = '2026-09-10T16:00:03.456Z'
	const now = '2026-09-10T17:00:00.000Z'
	const identity: typeof providerIdentity.$inferSelect = {
		id: 'proof-kit-identity',
		contactId: 'proof-contact',
		provider: 'kit',
		externalId: 'synthetic-kit-id',
		evidence: {},
		createdAt: new Date(verifiedAt),
		updatedAt: new Date(verifiedAt),
	}
	const login: EmailTokenLoginObservedPayload = {
		version: 1,
		contactId: identity.contactId,
		userId: 'proof-user',
		emailFingerprint: emailFingerprint(secret, 'proof@example.test'),
		verifiedAt,
		sessionTokenHash: sessionTokenHash(secret, 'synthetic-session'),
		tokenHash: emailTokenHash(secret, 'synthetic-token'),
		mechanism: 'auth-email-callback',
		observedAt: loginObserved,
	}
	const claim: OfferClaimObservedPayload = {
		version: 1,
		journeyId: 'evergreen-offer:proof-contact',
		contactId: identity.contactId,
		verifiedUserId: login.userId,
		attestationEventId: 'proof-login-event',
		sessionTokenHash: login.sessionTokenHash,
		emailFingerprint: login.emailFingerprint,
		verifiedAt,
		observedAt: claimObserved,
	}
	const rows: (typeof contactEvent.$inferSelect)[] = [
		{
			...emailTokenLoginEventRow({
				resolution: resolveOwnerContact(
					[identity.contactId],
					identity.contactId,
				),
				id: claim.attestationEventId,
				identity: { ...identity, provider: 'kit' },
				payload: login,
			}),
			createdAt: new Date(loginObserved),
		},
		{
			...offerClaimEventRow({
				resolution: resolveOwnerContact(
					[identity.contactId],
					identity.contactId,
				),
				id: 'proof-claim-event',
				identity: { ...identity, provider: 'kit' },
				payload: claim,
			}),
			createdAt: new Date(claimObserved),
		},
	]
	const j = parseJourneyId(claim.journeyId)
	const u = parseVerifiedUserId(login.userId)
	if (!j.ok || !u.ok) throw new Error('Invalid fixture identity')
	const intentKey = couponBindingIntentKey({
		journeyId: j.value,
		verifiedUserId: u.value,
	})
	const intent = {
		type: 'BindCoupon',
		idempotencyKey: intentKey,
		journeyId: claim.journeyId,
		contactId: claim.contactId,
		couponId: 'proof-coupon',
		verifiedUserId: login.userId,
	}
	const stimulus = {
		type: 'VerifiedUserObserved',
		stimulusId: 'proof-claim-event',
		journeyId: claim.journeyId,
		verifiedUserId: login.userId,
		observedAt: claimObserved,
		sourceReference: claimSourceReference('proof-claim-event'),
	}
	const events = [
		{
			type: 'CouponBindingIntentCommitted',
			occurredAt: committedAt,
			details: {
				couponId: intent.couponId,
				verifiedUserId: login.userId,
				intentKey,
			},
		},
	]
	const receipt = {
		stimulusId: stimulus.stimulusId,
		journeyId: claim.journeyId,
		from: 'pitch.running',
		to: 'pitch.running',
		committedAt,
		evidenceVersion: 'synthetic-facts',
	}
	const commit: typeof evergreenOfferJourneyCommit.$inferSelect = {
		format: EVERGREEN_OFFER_JOURNEY_COMMIT_FORMAT,
		stimulusId: stimulus.stimulusId,
		journeyId: claim.journeyId,
		actorVersion: 4,
		admissionContactId: null,
		stimulusType: stimulus.type,
		commitEvidence: {
			format: EVERGREEN_OFFER_JOURNEY_COMMIT_EVIDENCE_FORMAT,
			expectedVersion: 3,
			stimulus,
			currentFacts: {
				contactId: claim.contactId,
				purchase: null,
				delivery: { type: 'Eligible' },
				existingJourneyId: claim.journeyId,
				automationControl: { type: 'Enabled', version: 'synthetic-control' },
				evidenceVersion: 'synthetic-facts',
				readAt: committedAt,
			},
			definition: EVERGREEN_OFFER_JOURNEY_V1,
			decidedAt: committedAt,
		},
		decision: { type: 'Accepted', sideEffectIntents: [intent] },
		snapshot: {},
		events,
		receipt,
		decidedAt: new Date(committedAt),
		committedAt: new Date(committedAt),
	}
	const intentRow: typeof evergreenOfferJourneyIntent.$inferSelect = {
		format: EVERGREEN_OFFER_JOURNEY_INTENT_FORMAT,
		idempotencyKey: intentKey,
		journeyId: claim.journeyId,
		originatingStimulusId: stimulus.stimulusId,
		actorVersion: 4,
		ordinal: 0,
		intentType: 'BindCoupon',
		intent,
		status: 'Pending',
		availableAt: new Date(committedAt),
		settledByStimulusId: null,
		settledAt: null,
		createdAt: new Date(committedAt),
		updatedAt: new Date(committedAt),
	}
	const input: VerifiedCouponOwnerQuery = {
		contactId: claim.contactId,
		journeyId: claim.journeyId,
		verifiedUserId: login.userId,
		couponId: intent.couponId,
		lockedContact: { id: claim.contactId, email: 'proof@example.test' },
		lockedUser: {
			id: login.userId,
			email: 'proof@example.test',
			emailVerified: verifiedAt,
		},
	}
	const calls: string[] = []
	const store: VerifiedOwnerEvidenceReadStore = {
		intent: async (key) => {
			calls.push(`intent:${key}`)
			return key === intentRow.idempotencyKey ? intentRow : null
		},
		commit: async (id) => {
			calls.push(`commit:${id}`)
			return id === commit.stimulusId ? commit : null
		},
		event: async (id) => {
			calls.push(`event:${id}`)
			return rows.find((row) => row.id === id) ?? null
		},
		identity: async (id) => {
			calls.push(`identity:${id}`)
			return id === identity.id ? identity : null
		},
	}
	return {
		secret,
		now,
		input,
		identity,
		login,
		claim,
		rows,
		commit,
		intentRow,
		store,
		calls,
	}
}
