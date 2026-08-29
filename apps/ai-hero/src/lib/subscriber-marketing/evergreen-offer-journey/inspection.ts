import type {
	EvergreenOfferJourneyAggregate,
	JourneyOperationalStatus,
	JourneyView,
} from './domain'
import type { IntentKey, IsoInstant } from './primitives'

export type IntentOperationalEvidence = {
	readonly idempotencyKey: IntentKey
	readonly status: 'pending' | 'applied' | 'refused' | 'ambiguous'
}

export function inspectEvergreenOfferJourney(args: {
	aggregate: EvergreenOfferJourneyAggregate
	now: IsoInstant
	automationControl: 'Enabled' | 'Stopped'
	intentEvidence: readonly IntentOperationalEvidence[]
	evidenceVersion: string
}): JourneyView {
	return {
		aggregate: args.aggregate,
		operationalStatus: operationalStatus(args),
		nextOpenSlots: [
			...args.aggregate.messagePlan.bridge,
			...args.aggregate.messagePlan.pitch,
		].filter(
			(slot) =>
				(slot.status === 'Scheduled' || slot.status === 'IntentCommitted') &&
				Date.parse(slot.dueAt) <= Date.parse(args.now) &&
				Date.parse(slot.windowEndsAt) > Date.parse(args.now),
		),
		evidenceVersion: args.evidenceVersion,
	}
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
