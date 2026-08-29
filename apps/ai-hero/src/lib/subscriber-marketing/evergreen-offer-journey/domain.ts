import type {
	ContactId,
	ContentResourceId,
	CouponId,
	EntryFactId,
	IanaTimeZone,
	IntentKey,
	IsoInstant,
	JourneyId,
	MessageSlotId,
	PresentationBundleId,
	StimulusId,
	VerifiedUserId,
	WakeId,
} from './primitives'

export const EVERGREEN_OFFER_JOURNEY_SCHEMA_VERSION = 1 as const
export const EVERGREEN_OFFER_PRODUCT_ID = 'product-ma254' as const
export const EVERGREEN_OFFER_CURRENCY = 'USD' as const
export const EVERGREEN_OFFER_AMOUNT_OFF_CENTS = 10_000 as const
export const EVERGREEN_OFFER_MAX_USES = 1 as const
export const EVERGREEN_OFFER_FALLBACK_TIME_ZONE =
	'America/Los_Angeles' as const

export type DeadlineTimeZoneEvidence =
	| {
			readonly type: 'BrowserEntryHeader'
			readonly headerName: 'x-vercel-ip-timezone'
			readonly timeZone: IanaTimeZone
			readonly capturedAt: IsoInstant
	  }
	| {
			readonly type: 'ExplicitFallback'
			readonly reason: 'header-missing' | 'header-invalid' | 'legacy-entry'
			readonly timeZone: IanaTimeZone
			readonly capturedAt: IsoInstant
	  }

export type CourseCompleted = {
	readonly type: 'CourseCompleted'
	readonly stimulusId: StimulusId
	readonly entryFactId: EntryFactId
	readonly contactId: ContactId
	readonly valuePathId: string
	readonly completedAt: IsoInstant
	readonly deadlineTimeZone: DeadlineTimeZoneEvidence
	readonly sourceReference: string
}

export type WakeDue = {
	readonly type: 'WakeDue'
	readonly stimulusId: StimulusId
	readonly journeyId: JourneyId
	readonly wakeId: WakeId
	readonly dueAt: IsoInstant
	readonly purpose:
		| { readonly type: 'MessageSlot'; readonly slotId: MessageSlotId }
		| { readonly type: 'CouponIssue' }
		| { readonly type: 'CouponExpiry' }
}

export type DeliveryOutcome =
	| { readonly type: 'Applied'; readonly providerReceiptId: string }
	| { readonly type: 'MessageRefused'; readonly reason: string }
	| { readonly type: 'ContactUndeliverable'; readonly reason: string }
	| { readonly type: 'Ambiguous'; readonly reason: string }

export type DeliverySettled = {
	readonly type: 'DeliverySettled'
	readonly stimulusId: StimulusId
	readonly journeyId: JourneyId
	readonly slotId: MessageSlotId
	readonly intentKey: IntentKey
	readonly settledAt: IsoInstant
	readonly outcome: DeliveryOutcome
}

export type CouponTerms = {
	readonly productId: typeof EVERGREEN_OFFER_PRODUCT_ID
	readonly currency: typeof EVERGREEN_OFFER_CURRENCY
	readonly amountOffCents: typeof EVERGREEN_OFFER_AMOUNT_OFF_CENTS
	readonly maxUses: typeof EVERGREEN_OFFER_MAX_USES
	readonly exclusive: true
}

export type CouponBinding =
	| { readonly type: 'AwaitingVerifiedUser' }
	| {
			readonly type: 'BindingIntentCommitted'
			readonly verifiedUserId: VerifiedUserId
			readonly intentKey: IntentKey
			readonly committedAt: IsoInstant
	  }
	| {
			readonly type: 'BoundToVerifiedUser'
			readonly verifiedUserId: VerifiedUserId
			readonly boundAt: IsoInstant
	  }

export type IssuedCoupon = {
	readonly couponId: CouponId
	readonly contactId: ContactId
	readonly issuedAt: IsoInstant
	readonly expiresAt: IsoInstant
	readonly deadlineTimeZone: DeadlineTimeZoneEvidence
	readonly terms: CouponTerms
	readonly binding: CouponBinding
}

export type CouponIssued = {
	readonly type: 'CouponIssued'
	readonly stimulusId: StimulusId
	readonly journeyId: JourneyId
	readonly intentKey: IntentKey
	readonly coupon: IssuedCoupon
}

export type VerifiedUserObserved = {
	readonly type: 'VerifiedUserObserved'
	readonly stimulusId: StimulusId
	readonly journeyId: JourneyId
	readonly verifiedUserId: VerifiedUserId
	readonly observedAt: IsoInstant
	readonly sourceReference: string
}

export type CouponBoundToUser = {
	readonly type: 'CouponBoundToUser'
	readonly stimulusId: StimulusId
	readonly journeyId: JourneyId
	readonly intentKey: IntentKey
	readonly couponId: CouponId
	readonly verifiedUserId: VerifiedUserId
	readonly boundAt: IsoInstant
}

export type ShadowNewsletterEntered = {
	readonly type: 'ShadowNewsletterEntered'
	readonly stimulusId: StimulusId
	readonly journeyId: JourneyId
	readonly intentKey: IntentKey
	readonly enteredAt: IsoInstant
	readonly providerReceiptId: string
}

export type PurchaseFact = {
	readonly purchaseId: string
	readonly offerProductFamily: 'ai-coding-crash-course'
	readonly sourceProductId: string
	readonly purchasedAt: IsoInstant
	readonly sourceReference: string
}

export type PurchaseObserved = {
	readonly type: 'PurchaseObserved'
	readonly stimulusId: StimulusId
	readonly journeyId: JourneyId
	readonly purchase: PurchaseFact
}

export type UnsubscribeObserved = {
	readonly type: 'UnsubscribeObserved'
	readonly stimulusId: StimulusId
	readonly journeyId: JourneyId
	readonly observedAt: IsoInstant
	readonly sourceReference: string
}

export type SuppressionObserved = {
	readonly type: 'SuppressionObserved'
	readonly stimulusId: StimulusId
	readonly journeyId: JourneyId
	readonly observedAt: IsoInstant
	readonly reason: string
	readonly sourceReference: string
}

export type OperatorStopObserved = {
	readonly type: 'OperatorStopObserved'
	readonly stimulusId: StimulusId
	readonly journeyId: JourneyId
	readonly observedAt: IsoInstant
	readonly reason: string
}

type PermanentEffectRefusalBase = {
	readonly type: 'PermanentEffectRefusal'
	readonly stimulusId: StimulusId
	readonly journeyId: JourneyId
	readonly intentKey: IntentKey
	readonly observedAt: IsoInstant
	readonly reason: string
}

export type PermanentEffectRefusal =
	| (PermanentEffectRefusalBase & {
			readonly scope: 'MessageLocal'
			readonly slotId: MessageSlotId
	  })
	| (PermanentEffectRefusalBase & { readonly scope: 'Contact' })

export type EvergreenOfferStimulus =
	| CourseCompleted
	| WakeDue
	| DeliverySettled
	| CouponIssued
	| VerifiedUserObserved
	| CouponBoundToUser
	| ShadowNewsletterEntered
	| PurchaseObserved
	| UnsubscribeObserved
	| SuppressionObserved
	| OperatorStopObserved
	| PermanentEffectRefusal

export type EligibilityFacts = {
	readonly contactId: ContactId
	readonly purchase: PurchaseFact | null
	readonly delivery:
		| { readonly type: 'Eligible' }
		| { readonly type: 'Unsubscribed'; readonly evidence: string }
		| { readonly type: 'Suppressed'; readonly evidence: string }
		| { readonly type: 'Undeliverable'; readonly evidence: string }
	readonly existingJourneyId: JourneyId | null
	readonly automationControl:
		| { readonly type: 'Enabled'; readonly version: string }
		| { readonly type: 'Stopped'; readonly version: string; readonly reason: string }
	readonly evidenceVersion: string
	readonly readAt: IsoInstant
}

export type EligibilityDecision =
	| { readonly type: 'Eligible'; readonly evidenceVersion: string }
	| {
			readonly type: 'Ineligible'
			readonly reason:
				| 'ExistingPurchase'
				| 'Unsubscribed'
				| 'Suppressed'
				| 'Undeliverable'
				| 'ExistingJourney'
				| 'AutomationStopped'
			readonly evidenceVersion: string
	  }

export type SelectedPresentation = {
	readonly bundleId: PresentationBundleId
	readonly subjectId: string
	readonly headlineId: string
	readonly openingId: string
	readonly ctaId: string
}

export type MessageDefinition = {
	readonly slotId: MessageSlotId
	readonly contentResourceId: ContentResourceId
	readonly presentation: SelectedPresentation
}

export type EvergreenOfferJourneyDefinition = {
	readonly definitionVersion: string
	readonly messagePlanId: string
	readonly messagePlanSourceHash: string
	readonly contentRevision: string
	readonly presentationReviewRevision: string
	readonly bridge: readonly [
		MessageDefinition,
		MessageDefinition,
		MessageDefinition,
	]
	readonly pitch: readonly [
		MessageDefinition,
		MessageDefinition,
		MessageDefinition,
		MessageDefinition,
		MessageDefinition,
	]
	readonly couponTerms: CouponTerms
}

type MessageSlotBase = MessageDefinition & {
	readonly phase: 'Bridge' | 'Pitch'
	readonly dueAt: IsoInstant
	readonly windowEndsAt: IsoInstant
}

export type MessageSlot =
	| (MessageSlotBase & { readonly status: 'Scheduled' })
	| (MessageSlotBase & {
			readonly status: 'IntentCommitted'
			readonly intentKey: IntentKey
			readonly committedAt: IsoInstant
	  })
	| (MessageSlotBase & {
			readonly status: 'Applied'
			readonly intentKey: IntentKey
			readonly settledAt: IsoInstant
			readonly providerReceiptId: string
	  })
	| (MessageSlotBase & {
			readonly status: 'Refused'
			readonly intentKey: IntentKey
			readonly settledAt: IsoInstant
			readonly reason: string
	  })
	| (MessageSlotBase & {
			readonly status: 'Ambiguous'
			readonly intentKey: IntentKey
			readonly settledAt: IsoInstant
			readonly reason: string
	  })
	| (MessageSlotBase & {
			readonly status: 'Missed'
			readonly intentKey: IntentKey | null
			readonly missedAt: IsoInstant
			readonly reason: 'DeliveryWindowClosed'
	  })

export type SelectedMessagePlan = {
	readonly definitionVersion: string
	readonly messagePlanId: string
	readonly messagePlanSourceHash: string
	readonly contentRevision: string
	readonly presentationReviewRevision: string
	readonly bridge: readonly [MessageSlot, MessageSlot, MessageSlot]
	readonly pitch: readonly MessageSlot[]
}

export type JourneyExit =
	| { readonly type: 'Purchased'; readonly purchase: PurchaseFact }
	| { readonly type: 'Unsubscribed'; readonly observedAt: IsoInstant }
	| {
			readonly type: 'Suppressed'
			readonly observedAt: IsoInstant
			readonly reason: string
	  }
	| {
			readonly type: 'OperatorStopped'
			readonly observedAt: IsoInstant
			readonly reason: string
	  }
	| {
			readonly type: 'PermanentFailure'
			readonly observedAt: IsoInstant
			readonly reason: string
	  }
	| { readonly type: 'EnteredShadowNewsletter'; readonly enteredAt: IsoInstant }

export type JourneyBase = {
	readonly schemaVersion: typeof EVERGREEN_OFFER_JOURNEY_SCHEMA_VERSION
	readonly journeyId: JourneyId
	readonly entryFactId: EntryFactId
	readonly contactId: ContactId
	readonly valuePathId: string
	readonly completedAt: IsoInstant
	readonly deadlineTimeZone: DeadlineTimeZoneEvidence
	readonly messagePlan: SelectedMessagePlan
	readonly version: number
}

export type ActiveJourneyAggregate =
	| (JourneyBase & { readonly phase: 'bridge.running'; readonly coupon: null })
	| (JourneyBase & { readonly phase: 'coupon.waiting'; readonly coupon: null })
	| (JourneyBase & {
			readonly phase: 'coupon.awaitingReceipt'
			readonly coupon: null
	  })
	| (JourneyBase & { readonly phase: 'pitch.running'; readonly coupon: IssuedCoupon })
	| (JourneyBase & {
			readonly phase: 'handoff.awaitingReceipt'
			readonly coupon: IssuedCoupon
	  })

export type FinalJourneyAggregate =
	| (JourneyBase & {
			readonly phase: 'customer'
			readonly coupon: IssuedCoupon | null
			readonly exit: Extract<JourneyExit, { type: 'Purchased' }>
	  })
	| (JourneyBase & {
			readonly phase: 'stopped'
			readonly coupon: IssuedCoupon | null
			readonly exit: Exclude<
				JourneyExit,
				{ type: 'Purchased' } | { type: 'EnteredShadowNewsletter' }
			>
	  })
	| (JourneyBase & {
			readonly phase: 'complete'
			readonly coupon: IssuedCoupon
			readonly exit: Extract<
				JourneyExit,
				{ type: 'EnteredShadowNewsletter' }
			>
	  })

export type EvergreenOfferJourneyAggregate =
	| ActiveJourneyAggregate
	| FinalJourneyAggregate

export type JourneyPhase = EvergreenOfferJourneyAggregate['phase']

export type SendMessageIntent = {
	readonly type: 'SendMessage'
	readonly idempotencyKey: IntentKey
	readonly journeyId: JourneyId
	readonly contactId: ContactId
	readonly slotId: MessageSlotId
	readonly contentResourceId: ContentResourceId
	readonly presentation: SelectedPresentation
	readonly notBefore: IsoInstant
	readonly notAfter: IsoInstant
	readonly couponId: CouponId | null
}

export type IssueCouponIntent = {
	readonly type: 'IssueCoupon'
	readonly idempotencyKey: IntentKey
	readonly journeyId: JourneyId
	readonly contactId: ContactId
	readonly issueAt: IsoInstant
	readonly expiresAt: IsoInstant
	readonly terms: CouponTerms
	readonly deadlineTimeZone: DeadlineTimeZoneEvidence
}

export type BindCouponIntent = {
	readonly type: 'BindCoupon'
	readonly idempotencyKey: IntentKey
	readonly journeyId: JourneyId
	readonly couponId: CouponId
	readonly contactId: ContactId
	readonly verifiedUserId: VerifiedUserId
}

export type EnterShadowNewsletterIntent = {
	readonly type: 'EnterShadowNewsletter'
	readonly idempotencyKey: IntentKey
	readonly journeyId: JourneyId
	readonly contactId: ContactId
}

export type SideEffectIntent =
	| SendMessageIntent
	| IssueCouponIntent
	| BindCouponIntent
	| EnterShadowNewsletterIntent

export type ScheduleWakeIntent = {
	readonly type: 'ScheduleWake'
	readonly wakeId: WakeId
	readonly journeyId: JourneyId
	readonly dueAt: IsoInstant
	readonly purpose: WakeDue['purpose']
}

type JourneyDomainEventBase = { readonly occurredAt: IsoInstant }

export type JourneyDomainEvent =
	| (JourneyDomainEventBase & {
			readonly type: 'JourneyStarted'
			readonly details: { readonly journeyId: JourneyId }
	  })
	| (JourneyDomainEventBase & {
			readonly type: 'MessageIntentCommitted'
			readonly details: {
				readonly slotId: MessageSlotId
				readonly idempotencyKey: IntentKey
			}
	  })
	| (JourneyDomainEventBase & {
			readonly type: 'MessageSettled'
			readonly details: {
				readonly slotId: MessageSlotId
				readonly intentKey: IntentKey
				readonly outcome: DeliveryOutcome['type']
			}
	  })
	| (JourneyDomainEventBase & {
			readonly type: 'MessageMissed'
			readonly details: {
				readonly slotId: MessageSlotId
				readonly intentKey: IntentKey | null
			}
	  })
	| (JourneyDomainEventBase & {
			readonly type: 'CouponIntentCommitted'
			readonly details: { readonly idempotencyKey: IntentKey }
	  })
	| (JourneyDomainEventBase & {
			readonly type: 'CouponRecorded'
			readonly details: {
				readonly couponId: CouponId
				readonly expiresAt: IsoInstant
			}
	  })
	| (JourneyDomainEventBase & {
			readonly type: 'CouponBindingIntentCommitted'
			readonly details: {
				readonly couponId: CouponId
				readonly verifiedUserId: VerifiedUserId
				readonly intentKey: IntentKey
			}
	  })
	| (JourneyDomainEventBase & {
			readonly type: 'CouponBindingRecorded'
			readonly details: {
				readonly couponId: CouponId
				readonly bindingIntentKey: IntentKey
			}
	  })
	| (JourneyDomainEventBase & {
			readonly type: 'HandoffIntentCommitted'
			readonly details: { readonly idempotencyKey: IntentKey }
	  })
	| (JourneyDomainEventBase & {
			readonly type: 'JourneyExited'
			readonly details: { readonly reason: JourneyExit['type'] }
	  })

export type TransitionReceipt = {
	readonly stimulusId: StimulusId
	readonly journeyId: JourneyId
	readonly from: JourneyPhase | 'not_started'
	readonly to: JourneyPhase
	readonly committedAt: IsoInstant
	readonly evidenceVersion: string
}

export type JourneyDecision =
	| {
			readonly type: 'Accepted'
			readonly next: EvergreenOfferJourneyAggregate
			readonly events: readonly JourneyDomainEvent[]
			readonly sideEffectIntents: readonly SideEffectIntent[]
			readonly wakeIntents: readonly ScheduleWakeIntent[]
			readonly transitionReceipt: TransitionReceipt
	  }
	| {
			readonly type: 'Ignored'
			readonly reason:
				| 'EntryIneligible'
				| 'JourneyAlreadyStarted'
				| 'JourneyFinal'
				| 'StimulusForAnotherJourney'
				| 'UnknownSlot'
				| 'SlotAlreadySettled'
				| 'SlotIntentAlreadyCommitted'
				| 'CouponAlreadyBound'
				| 'CouponBindingIntentAlreadyCommitted'
				| 'SlotNotOpen'
				| 'UnexpectedStimulusForPhase'
			readonly current: EvergreenOfferJourneyAggregate | null
			readonly eligibility?: EligibilityDecision
	  }

export type JourneyDecisionError =
	| {
			readonly type: 'ScheduleInvalid'
			readonly reason: string
	  }
	| {
			readonly type: 'InvariantViolation'
			readonly reason: string
	  }

export type JourneyDecisionResult =
	| { readonly ok: true; readonly decision: JourneyDecision }
	| { readonly ok: false; readonly error: JourneyDecisionError }

export type DecideEvergreenOfferJourneyInput = {
	readonly snapshot: EvergreenOfferJourneyAggregate | null
	readonly stimulus: EvergreenOfferStimulus
	readonly currentFacts: EligibilityFacts
	readonly definition: EvergreenOfferJourneyDefinition
	readonly now: IsoInstant
}

export type JourneyOperationalStatus =
	| 'active'
	| 'blocked'
	| 'halted'
	| 'complete'

export type JourneyView = {
	readonly aggregate: EvergreenOfferJourneyAggregate
	readonly operationalStatus: JourneyOperationalStatus
	readonly nextOpenSlots: readonly MessageSlot[]
	readonly evidenceVersion: string
}
