import { fixtureEntry } from './bounded-readers.fixtures'
import { decideEvergreenOfferJourney } from './decision'
import { EVERGREEN_OFFER_JOURNEY_V2 } from './definition'
import type {
	EvergreenOfferJourneyAggregate,
	EvergreenOfferJourneyDefinition,
	EvergreenOfferStimulus,
} from './domain'
import type { JourneyLedgerCommit } from './ports'
import {
	couponExpiresAtForOpening,
	deadlineTimeZoneEvidenceFromHeader,
} from './calendar'
import { parseCouponId, parseIsoInstant, parseStimulusId } from './primitives'

export function calendarInstant(at: string) {
	const p = parseIsoInstant(at)
	if (!p.ok) throw new Error('Invalid fixture time')
	return p.value
}
export function calendarStimulusId(id: string) {
	const p = parseStimulusId(id)
	if (!p.ok) throw new Error('Invalid fixture ID')
	return p.value
}
export function calendarCommit(
	snapshot: EvergreenOfferJourneyAggregate | null,
	stimulus: EvergreenOfferStimulus,
	at: string,
	definition: EvergreenOfferJourneyDefinition,
): JourneyLedgerCommit {
	const contactId =
		snapshot?.contactId ??
		(stimulus.type === 'CourseSequenceExhausted' ? stimulus.contactId : null)
	if (!contactId) throw new Error('Missing fixture contact')
	const currentFacts = {
		contactId,
		purchase: null,
		delivery: { type: 'Eligible' as const },
		existingJourneyId: snapshot?.journeyId ?? null,
		automationControl: { type: 'Enabled' as const, version: 'test' },
		evidenceVersion: 'test',
		readAt: calendarInstant(at),
	}
	const result = decideEvergreenOfferJourney({
		snapshot,
		stimulus,
		currentFacts,
		definition,
		now: calendarInstant(at),
	})
	if (!result.ok || result.decision.type !== 'Accepted')
		throw new Error(`Fixture rejected: ${JSON.stringify(result)}`)
	return {
		stimulus,
		expectedVersion: snapshot?.version ?? null,
		currentFacts,
		definition,
		decidedAt: calendarInstant(at),
		decision: result.decision,
	}
}
export function calendarEntry(
	definition: EvergreenOfferJourneyDefinition = EVERGREEN_OFFER_JOURNEY_V2,
	id = 'calendar-version',
) {
	const legacy = fixtureEntry(id)
	if (legacy.stimulus.type !== 'CourseSequenceExhausted')
		throw new Error('Missing entry')
	const zone = deadlineTimeZoneEvidenceFromHeader({
		headerValue: 'America/Los_Angeles',
		capturedAt: legacy.stimulus.exhaustedAt,
	})
	if (!zone.ok) throw new Error('Invalid fixture zone')
	return calendarCommit(
		null,
		{ ...legacy.stimulus, deadlineTimeZone: zone.value },
		legacy.decidedAt,
		definition,
	)
}
export function calendarFlow(
	definition: EvergreenOfferJourneyDefinition = EVERGREEN_OFFER_JOURNEY_V2,
	id = 'calendar-version',
) {
	const entry = calendarEntry(definition, id)
	const wake = entry.decision.wakeIntents.find(
		(wake) => wake.purpose.type === 'CouponIssue',
	)
	if (!wake) throw new Error('Missing coupon wake')
	const pending = calendarCommit(
		entry.decision.next,
		{
			type: 'WakeDue',
			stimulusId: calendarStimulusId(`${id}-wake`),
			journeyId: wake.journeyId,
			wakeId: wake.wakeId,
			dueAt: wake.dueAt,
			purpose: wake.purpose,
		},
		wake.dueAt,
		definition,
	)
	const intent = pending.decision.sideEffectIntents.find(
		(intent) => intent.type === 'IssueCoupon',
	)
	if (!intent || intent.type !== 'IssueCoupon')
		throw new Error('Missing issue intent')
	const couponId = parseCouponId(`${id}-coupon`)
	if (!couponId.ok) throw new Error('Bad coupon ID')
	const issued: Extract<EvergreenOfferStimulus, { type: 'CouponIssued' }> = {
		type: 'CouponIssued',
		stimulusId: calendarStimulusId(`${id}-issued`),
		journeyId: wake.journeyId,
		intentKey: intent.idempotencyKey,
		coupon: {
			couponId: couponId.value,
			contactId: intent.contactId,
			issuedAt: intent.issueAt,
			expiresAt: couponExpiresAtForOpening({
				openingAt: intent.issueAt,
				timeZone: intent.deadlineTimeZone.timeZone,
			}),
			deadlineTimeZone: intent.deadlineTimeZone,
			terms: intent.terms,
			binding: { type: 'AwaitingVerifiedUser' },
		},
	}
	const pitch = calendarCommit(
		pending.decision.next,
		issued,
		intent.issueAt,
		definition,
	)
	const terminal = calendarCommit(
		pitch.decision.next,
		{
			type: 'OperatorStopObserved',
			stimulusId: calendarStimulusId(`${id}-stop`),
			journeyId: wake.journeyId,
			observedAt: intent.issueAt,
			reason: 'fixture stop',
		},
		intent.issueAt,
		definition,
	)
	return { entry, pending, issued, pitch, terminal, wake, intent }
}
