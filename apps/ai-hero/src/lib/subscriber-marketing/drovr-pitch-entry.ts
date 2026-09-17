import type { CaptureMarketingRepository } from './capture-contact-event'
import { normalizeEmail } from './contact-email-equivalence'
import {
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	type DrovrJourneyId,
} from './drovr-shadow-emitter'
import {
	findJourneyOwnerAssignment,
	recordJourneyOwnerAssigned,
} from './drovr-ownership'
import type {
	ContactLifecycle,
	ContactRecord,
	ProviderIdentityRecord,
} from './types'

export const CRASH_COURSE_PRODUCT_ID = 'product-ma254' as const
export const CRASH_COURSE_PURCHASE_STATUSES = ['Valid', 'Restricted'] as const

export type CrashCoursePurchaseEvidence = {
	userId: string | null
	userEmail?: string | null
	productId: string
	status: string
}

export function hasCrashCoursePurchaseForIdentity(args: {
	userIds: readonly string[]
	emails: readonly string[]
	purchases: readonly CrashCoursePurchaseEvidence[]
}): boolean {
	const userIds = new Set(args.userIds)
	const emails = new Set(args.emails.map(normalizeEmail))
	return args.purchases.some(
		(purchase) =>
			purchase.productId === CRASH_COURSE_PRODUCT_ID &&
			CRASH_COURSE_PURCHASE_STATUSES.some(
				(status) => status === purchase.status,
			) &&
			((purchase.userId !== null && userIds.has(purchase.userId)) ||
				Boolean(
					purchase.userEmail && emails.has(normalizeEmail(purchase.userEmail)),
				)),
	)
}

export type PitchEligibilityEvidence = {
	finishedCourse: boolean
	hasCrashCoursePurchase: boolean
	unsubscribed: boolean
}

export type PitchIneligibilityReason =
	| 'course-not-finished'
	| 'crash-course-purchaser'
	| 'unsubscribed'

export type PitchEligibilityDecision =
	| { eligible: true }
	| { eligible: false; reason: PitchIneligibilityReason }

/** Pure entry policy. Live reads belong to the repository boundary below. */
export function decidePitchEligibility(
	evidence: PitchEligibilityEvidence,
): PitchEligibilityDecision {
	if (!evidence.finishedCourse) {
		return { eligible: false, reason: 'course-not-finished' }
	}
	if (evidence.hasCrashCoursePurchase) {
		return { eligible: false, reason: 'crash-course-purchaser' }
	}
	if (evidence.unsubscribed) {
		return { eligible: false, reason: 'unsubscribed' }
	}
	return { eligible: true }
}

export type EvergreenPitchEntryEvidence = {
	contact: ContactRecord & { email: string }
	providerIdentity: ProviderIdentityRecord
	/** Read from AI_Purchase at entry, never inferred from a contact event. */
	hasCrashCoursePurchase: boolean
	/** Contact/state suppression or a recorded contact.unsubscribed event. */
	unsubscribed: boolean
}

type MaybePromise<Value> = Value | Promise<Value>

export type EvergreenPitchEntryRepository = Pick<
	CaptureMarketingRepository,
	'findContactEventsByType' | 'createContactEvent'
> & {
	readEvergreenPitchEntryEvidence(
		contactId: string,
	): MaybePromise<EvergreenPitchEntryEvidence | undefined>
}

export type EvergreenPitchEntryResult =
	| {
			status: 'entered' | 'already-entered'
			journeyId: typeof DROVR_EVERGREEN_OFFER_JOURNEY_ID
	  }
	| {
			status: 'refused'
			reason: PitchIneligibilityReason | 'contact-or-identity-missing'
	  }

/**
 * The one forward-route seam. It proves eligibility from live evidence,
 * then records evergreen ownership. The assignment is idempotent per journey;
 * recording it dispatches the authority-tenant birth through the existing
 * ContactEvent path.
 */
export async function enterEvergreenPitch(args: {
	repository: EvergreenPitchEntryRepository
	contactId: string
	completedAt: string
}): Promise<EvergreenPitchEntryResult> {
	const evidence = await args.repository.readEvergreenPitchEntryEvidence(
		args.contactId,
	)
	if (!evidence) {
		return { status: 'refused', reason: 'contact-or-identity-missing' }
	}
	const decision = decidePitchEligibility({
		finishedCourse: true,
		hasCrashCoursePurchase: evidence.hasCrashCoursePurchase,
		unsubscribed: evidence.unsubscribed,
	})
	if (!decision.eligible) return { status: 'refused', reason: decision.reason }

	const journeyId: DrovrJourneyId = DROVR_EVERGREEN_OFFER_JOURNEY_ID
	const existing = await findJourneyOwnerAssignment(
		args.repository,
		args.contactId,
		journeyId,
	)
	if (existing) return { status: 'already-entered', journeyId }

	await recordJourneyOwnerAssigned({
		repository: args.repository,
		contactId: evidence.contact.id,
		providerIdentityId: evidence.providerIdentity.id,
		kitSubscriberId: evidence.providerIdentity.externalId,
		provider: evidence.providerIdentity.provider,
		providerExternalId: evidence.providerIdentity.externalId,
		email: evidence.contact.email,
		name: evidence.contact.name ?? undefined,
		occurredAt: args.completedAt,
		journeyId,
	})
	return { status: 'entered', journeyId }
}

export function isSuppressedLifecycle(
	lifecycle: ContactLifecycle | undefined,
): boolean {
	return lifecycle === 'suppressed'
}
