import type { Effect } from 'effect'

import type {
	DecideEvergreenOfferJourneyInput,
	EligibilityFacts,
	EvergreenOfferJourneyAggregate,
	IssuedCoupon,
	EvergreenOfferStimulus,
	IssueCouponIntent,
	JourneyDecision,
	JourneyDecisionResult,
	JourneyView,
	ScheduleWakeIntent,
	SideEffectIntent,
	TransitionReceipt,
} from './domain'
import type {
	ContactId,
	IntentKey,
	IsoInstant,
	JourneyId,
	StimulusId,
	WakeId,
} from './primitives'

export type JourneyCommandError =
	| { readonly type: 'JourneyDecodeFailure'; readonly reason: string }
	| { readonly type: 'JourneyVersionConflict'; readonly journeyId: JourneyId }
	| {
			readonly type: 'JourneyConstraintViolation'
			readonly journeyId: JourneyId
			readonly reason: string
	  }
	| { readonly type: 'JourneyCommitUnavailable'; readonly reason: string }
	| { readonly type: 'AuthorityUnavailable'; readonly reason: string }
	| { readonly type: 'AuthorityInconsistent'; readonly reason: string }
	| { readonly type: 'JourneyDecisionFailure'; readonly reason: string }

export type JourneyQueryError =
	| { readonly type: 'JourneyNotFound'; readonly journeyId: JourneyId }
	| { readonly type: 'JourneyDecodeFailure'; readonly reason: string }
	| { readonly type: 'JourneyQueryUnavailable'; readonly reason: string }

export type EffectApplicationError =
	| { readonly type: 'EffectPermanentRefusal'; readonly reason: string }
	| { readonly type: 'EffectTransientUnavailable'; readonly reason: string }
	| { readonly type: 'EffectAmbiguous'; readonly reason: string }

export type JourneyLedgerCommit = {
	readonly stimulus: EvergreenOfferStimulus
	readonly expectedVersion: number | null
	readonly currentFacts: EligibilityFacts
	readonly definition: DecideEvergreenOfferJourneyInput['definition']
	readonly decidedAt: IsoInstant
	readonly decision: Extract<JourneyDecision, { type: 'Accepted' }>
}

export type CommittedJourneyDecision = {
	readonly decision: JourneyDecision
	readonly committed: boolean
	readonly replayedStimulus: boolean
}

export interface JourneyLedger {
	readonly load: (
		journeyId: JourneyId,
	) => Effect.Effect<
		EvergreenOfferJourneyAggregate | null,
		Extract<JourneyCommandError, { type: 'JourneyDecodeFailure' }> | {
			readonly type: 'JourneyCommitUnavailable'
			readonly reason: string
		}
	>
	readonly findCommittedStimulus: (
		stimulusId: StimulusId,
	) => Effect.Effect<CommittedJourneyDecision | null, JourneyCommandError>
	readonly commit: (
		commit: JourneyLedgerCommit,
	) => Effect.Effect<CommittedJourneyDecision, JourneyCommandError>
	readonly inspect: (args: {
		readonly journeyId: JourneyId
		readonly now: IsoInstant
		readonly automationControl: 'Enabled' | 'Stopped'
	}) => Effect.Effect<JourneyView, JourneyQueryError>
}

export interface JourneyClock {
	readonly now: Effect.Effect<
		IsoInstant,
		{ readonly type: 'ClockUnavailable'; readonly reason: string }
	>
}

export interface OfferAuthority {
	readonly currentFacts: (args: {
		contactId: ContactId
		journeyId: JourneyId | null
	}) => Effect.Effect<EligibilityFacts, JourneyCommandError>
}

export type CouponIssueReceipt = {
	readonly coupon: IssuedCoupon
	readonly providerReceiptId: string
}

export type CouponBindingReceipt = {
	readonly coupon: IssuedCoupon
	readonly providerReceiptId: string
}

export type DeliveryApplicationReceipt = {
	readonly providerReceiptId: string
	readonly appliedAt: IsoInstant
}

export type AudienceEntryReceipt = {
	readonly providerReceiptId: string
	readonly enteredAt: IsoInstant
}

export interface CouponAuthority {
	readonly issue: (
		intent: IssueCouponIntent,
	) => Effect.Effect<CouponIssueReceipt, EffectApplicationError>
	readonly bind: (
		intent: Extract<SideEffectIntent, { type: 'BindCoupon' }>,
	) => Effect.Effect<CouponBindingReceipt, EffectApplicationError>
}

export interface DeliveryPort {
	readonly apply: (
		intent: Extract<SideEffectIntent, { type: 'SendMessage' }>,
	) => Effect.Effect<DeliveryApplicationReceipt, EffectApplicationError>
}

export interface AudiencePort {
	readonly enter: (
		intent: Extract<SideEffectIntent, { type: 'EnterShadowNewsletter' }>,
	) => Effect.Effect<AudienceEntryReceipt, EffectApplicationError>
}

export interface WakeScheduler {
	readonly apply: (
		intent: ScheduleWakeIntent,
	) => Effect.Effect<
		{ readonly wakeId: WakeId; readonly schedulerReceiptId: string },
		EffectApplicationError
	>
}

export interface OperationalReceiptSink {
	readonly record: (receipt: TransitionReceipt) => Effect.Effect<
		void,
		{ readonly type: 'ReceiptSinkUnavailable'; readonly reason: string }
	>
}

export interface EvergreenOfferJourneyService {
	readonly advance: (
		stimulus: EvergreenOfferStimulus,
	) => Effect.Effect<CommittedJourneyDecision, JourneyCommandError>
	readonly inspect: (
		journeyId: JourneyId,
	) => Effect.Effect<JourneyView, JourneyQueryError>
}

export type JourneyDecisionCore = (
	input: DecideEvergreenOfferJourneyInput,
) => JourneyDecisionResult

export type ClaimableIntent = {
	readonly idempotencyKey: IntentKey
	readonly intent: SideEffectIntent
	readonly claimedAt: IsoInstant
}
