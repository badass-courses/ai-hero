import type {
	EvergreenOfferJourneyAggregate,
	JourneyOperationalStatus,
	JourneyView,
	ScheduleWakeIntent,
	SideEffectIntent,
	TransitionReceipt,
} from './domain'
import type { IsoInstant } from './primitives'

export type IntentOperationalEvidence = {
	readonly intent: SideEffectIntent
	readonly status: 'pending' | 'applied' | 'refused' | 'ambiguous' | 'missed'
}

export type WakeOperationalEvidence = {
	readonly wake: ScheduleWakeIntent
	readonly status: 'pending' | 'applied'
}

export function inspectEvergreenOfferJourney(args: {
	aggregate: EvergreenOfferJourneyAggregate
	now: IsoInstant
	automationControl: 'Enabled' | 'Stopped'
	intentEvidence: readonly IntentOperationalEvidence[]
	wakeEvidence?: readonly WakeOperationalEvidence[]
	transitionReceipts?: readonly TransitionReceipt[]
	evidenceVersion: string
}): JourneyView {
	const final = isFinal(args.aggregate)
	return {
		aggregate: args.aggregate,
		operationalStatus: operationalStatus(args),
		nextOpenSlots: final
			? []
			: [
					...args.aggregate.messagePlan.bridge,
					...args.aggregate.messagePlan.pitch,
				].filter(
					(slot) =>
						(slot.status === 'Scheduled' ||
							slot.status === 'IntentCommitted') &&
						Date.parse(slot.dueAt) <= Date.parse(args.now) &&
						Date.parse(slot.windowEndsAt) > Date.parse(args.now),
				),
		intents: args.intentEvidence,
		wakes: args.wakeEvidence ?? [],
		transitionReceipts: args.transitionReceipts ?? [],
		evidenceVersion: args.evidenceVersion,
	}
}

function isFinal(aggregate: EvergreenOfferJourneyAggregate) {
	return (
		aggregate.phase === 'customer' ||
		aggregate.phase === 'stopped' ||
		aggregate.phase === 'complete'
	)
}

function operationalStatus(args: {
	aggregate: EvergreenOfferJourneyAggregate
	automationControl: 'Enabled' | 'Stopped'
	intentEvidence: readonly IntentOperationalEvidence[]
}): JourneyOperationalStatus {
	if (
		args.aggregate.phase === 'customer' ||
		args.aggregate.phase === 'stopped' ||
		args.aggregate.phase === 'complete'
	) {
		return 'complete'
	}
	if (args.automationControl === 'Stopped') return 'halted'
	if (args.intentEvidence.some((intent) => intent.status === 'ambiguous')) {
		return 'blocked'
	}
	return 'active'
}
