import type { CommittedJourneyDecision } from './ports'
import type {
	EvergreenOfferStimulus,
	JourneyDomainEvent,
	ScheduleWakeIntent,
	SideEffectIntent,
	TransitionReceipt,
} from './domain'
import type { IntentKey, JourneyId, StimulusId, WakeId } from './primitives'

export const EVERGREEN_OFFER_JOURNEY_SNAPSHOT_FORMAT =
	'evergreen-offer-journey.snapshot.v1' as const
export const EVERGREEN_OFFER_JOURNEY_EVENT_FORMAT =
	'evergreen-offer-journey.event.v1' as const
export const EVERGREEN_OFFER_JOURNEY_INTENT_FORMAT =
	'evergreen-offer-journey.intent.v1' as const
export const EVERGREEN_OFFER_JOURNEY_WAKE_FORMAT =
	'evergreen-offer-journey.wake.v1' as const
export const EVERGREEN_OFFER_JOURNEY_STIMULUS_FORMAT =
	'evergreen-offer-journey.stimulus.v1' as const
export const EVERGREEN_OFFER_JOURNEY_RECEIPT_FORMAT =
	'evergreen-offer-journey.receipt.v1' as const
export const EVERGREEN_OFFER_JOURNEY_COMMIT_FORMAT =
	'evergreen-offer-journey.commit.v1' as const

export type JourneySnapshotRecord = {
	readonly format: typeof EVERGREEN_OFFER_JOURNEY_SNAPSHOT_FORMAT
	readonly journeyId: JourneyId
	readonly actorVersion: number
	readonly snapshotJson: string
}

export type JourneyEventRecord = {
	readonly format: typeof EVERGREEN_OFFER_JOURNEY_EVENT_FORMAT
	readonly journeyId: JourneyId
	readonly actorVersion: number
	readonly ordinal: number
	readonly event: JourneyDomainEvent
}

export type JourneyIntentRecord = {
	readonly format: typeof EVERGREEN_OFFER_JOURNEY_INTENT_FORMAT
	readonly journeyId: JourneyId
	readonly actorVersion: number
	readonly idempotencyKey: IntentKey
	readonly status: 'Pending' | 'Applied' | 'Refused' | 'Ambiguous' | 'Missed'
	readonly settledByStimulusId: StimulusId | null
	readonly intent: SideEffectIntent
}

export type JourneyWakeRecord = {
	readonly format: typeof EVERGREEN_OFFER_JOURNEY_WAKE_FORMAT
	readonly journeyId: JourneyId
	readonly actorVersion: number
	readonly wakeId: WakeId
	readonly status: 'Pending' | 'Applied'
	readonly settledByStimulusId: StimulusId | null
	readonly wake: ScheduleWakeIntent
}

export type JourneyStimulusRecord = {
	readonly format: typeof EVERGREEN_OFFER_JOURNEY_STIMULUS_FORMAT
	readonly journeyId: JourneyId
	readonly actorVersion: number
	readonly stimulusId: StimulusId
	readonly stimulus: EvergreenOfferStimulus
	readonly decision: CommittedJourneyDecision
}

export type JourneyTransitionReceiptRecord = {
	readonly format: typeof EVERGREEN_OFFER_JOURNEY_RECEIPT_FORMAT
	readonly journeyId: JourneyId
	readonly actorVersion: number
	readonly receipt: TransitionReceipt
}

export type JourneyLedgerRecords = {
	readonly snapshots: readonly JourneySnapshotRecord[]
	readonly events: readonly JourneyEventRecord[]
	readonly intents: readonly JourneyIntentRecord[]
	readonly wakes: readonly JourneyWakeRecord[]
	readonly stimuli: readonly JourneyStimulusRecord[]
	readonly receipts: readonly JourneyTransitionReceiptRecord[]
}

export type JourneyLedgerSeed = Partial<JourneyLedgerRecords>
