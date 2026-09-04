import { describe, expect, it } from 'vitest'

import {
	deadlineTimeZoneEvidenceFromHeader,
	decideEvergreenOfferJourney,
	EVERGREEN_OFFER_JOURNEY_V1,
} from '.'
import type { EligibilityFacts, EvergreenOfferStimulus } from './domain'
import {
	journeyCommitEvidenceRecord,
	restorePersistedDomainEvents,
	restorePersistedScheduleWake,
	restorePersistedSideEffectIntent,
	restorePersistedTransitionReceipt,
	validatePersistedCommitEvidenceEnvelope,
} from './persistence-codec'
import {
	parseContactId,
	parseEntryFactId,
	parseIanaTimeZone,
	parseIsoInstant,
	parseStimulusId,
	type ParseResult,
} from './primitives'

const contactId = value(parseContactId('contact_persistence_codec'))
const entryFactId = value(parseEntryFactId('entry_persistence_codec'))
const exhaustedAt = instant('2026-09-04T17:00:00.000Z')
const timeZone = value(parseIanaTimeZone('America/Los_Angeles'))

function facts(
	existingJourneyId: EligibilityFacts['existingJourneyId'] = null,
) {
	return {
		contactId,
		purchase: null,
		delivery: { type: 'Eligible' as const },
		existingJourneyId,
		automationControl: { type: 'Enabled' as const, version: 'control-v1' },
		evidenceVersion: 'facts-v1',
		readAt: exhaustedAt,
	}
}

function start() {
	const deadlineTimeZone = deadlineTimeZoneEvidenceFromHeader({
		headerValue: timeZone,
		capturedAt: exhaustedAt,
	})
	if (!deadlineTimeZone.ok) throw new Error(deadlineTimeZone.error.detail)
	const stimulus: EvergreenOfferStimulus = {
		type: 'CourseSequenceExhausted',
		stimulusId: value(parseStimulusId('stimulus_persistence_codec')),
		entryFactId,
		contactId,
		valuePathId: 'ai-hero-skills-workflow-individual-v1',
		exhaustedAt,
		deadlineTimeZone: deadlineTimeZone.value,
		sourceReference: 'contact-event:persistence-codec',
	}
	const result = decideEvergreenOfferJourney({
		snapshot: null,
		stimulus,
		currentFacts: facts(),
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		now: exhaustedAt,
	})
	if (!result.ok || result.decision.type !== 'Accepted') {
		throw new Error('Expected accepted entry')
	}
	return { stimulus, decision: result.decision }
}

function firstMessageDecision() {
	const entry = start()
	const wake = entry.decision.wakeIntents.find(
		(candidate) => candidate.purpose.type === 'MessageSlot',
	)
	if (!wake) throw new Error('Expected message wake')
	const stimulus: EvergreenOfferStimulus = {
		type: 'WakeDue',
		stimulusId: value(parseStimulusId('stimulus_persistence_codec_wake')),
		journeyId: entry.decision.next.journeyId,
		wakeId: wake.wakeId,
		dueAt: wake.dueAt,
		purpose: wake.purpose,
	}
	const result = decideEvergreenOfferJourney({
		snapshot: entry.decision.next,
		stimulus,
		currentFacts: facts(entry.decision.next.journeyId),
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		now: wake.dueAt,
	})
	if (!result.ok || result.decision.type !== 'Accepted') {
		throw new Error('Expected accepted message wake')
	}
	return { stimulus, decision: result.decision }
}

describe('evergreen journey persistence codecs', () => {
	it('restores normalized wakes, intents, events, and receipts', () => {
		const entry = start()
		const message = firstMessageDecision()
		expect(restorePersistedScheduleWake(entry.decision.wakeIntents[0])).toEqual(
			{ ok: true, value: entry.decision.wakeIntents[0] },
		)
		expect(
			restorePersistedSideEffectIntent(message.decision.sideEffectIntents[0]),
		).toEqual({ ok: true, value: message.decision.sideEffectIntents[0] })
		expect(restorePersistedDomainEvents(message.decision.events)).toEqual({
			ok: true,
			value: message.decision.events,
		})
		expect(
			restorePersistedTransitionReceipt(message.decision.transitionReceipt),
		).toEqual({ ok: true, value: message.decision.transitionReceipt })
	})

	it('rejects malformed semantic identity and fallback evidence', () => {
		const message = firstMessageDecision()
		const intent = message.decision.sideEffectIntents[0]
		if (!intent || intent.type !== 'SendMessage') {
			throw new Error('Expected message intent')
		}
		expect(
			restorePersistedSideEffectIntent({
				...intent,
				idempotencyKey: '',
			}),
		).toMatchObject({ ok: false })
		expect(
			restorePersistedSideEffectIntent({
				...intent,
				presentation: { ...intent.presentation, bundleId: '' },
			}),
		).toMatchObject({ ok: false })
	})

	it('keeps full commit evidence recoverable and bound to its stimulus row', () => {
		const entry = start()
		const commit = {
			stimulus: entry.stimulus,
			expectedVersion: null,
			currentFacts: facts(),
			definition: EVERGREEN_OFFER_JOURNEY_V1,
			decidedAt: entry.decision.transitionReceipt.committedAt,
			decision: entry.decision,
		}
		const evidence = journeyCommitEvidenceRecord(commit)
		expect(evidence.stimulus).toMatchObject({
			type: 'CourseSequenceExhausted',
			exhaustedAt,
		})
		expect(evidence.stimulus).not.toHaveProperty('completedAt')
		const expected = {
			stimulusId: entry.stimulus.stimulusId,
			stimulusType: entry.stimulus.type,
			journeyId: entry.decision.next.journeyId,
			actorVersion: 1,
			decidedAt: entry.decision.transitionReceipt.committedAt,
		}
		expect(
			validatePersistedCommitEvidenceEnvelope(evidence, expected),
		).toMatchObject({ ok: true })
		expect(
			validatePersistedCommitEvidenceEnvelope(evidence, {
				...expected,
				stimulusId: 'another-stimulus',
			}),
		).toMatchObject({ ok: false })
		expect(
			validatePersistedCommitEvidenceEnvelope(
				{ ...evidence, currentFacts: {} },
				expected,
			),
		).toMatchObject({ ok: false })
		expect(
			validatePersistedCommitEvidenceEnvelope(
				{ ...evidence, definition: {} },
				expected,
			),
		).toMatchObject({ ok: false })
	})

	it('rejects the retired completion stimulus at the commit boundary', () => {
		const entry = start()
		const commit = {
			stimulus: entry.stimulus,
			expectedVersion: null,
			currentFacts: facts(),
			definition: EVERGREEN_OFFER_JOURNEY_V1,
			decidedAt: entry.decision.transitionReceipt.committedAt,
			decision: entry.decision,
		}
		const evidence = journeyCommitEvidenceRecord(commit)
		const legacy = JSON.parse(JSON.stringify(evidence))
		legacy.stimulus.type = 'CourseCompleted'
		legacy.stimulus.completedAt = legacy.stimulus.exhaustedAt
		delete legacy.stimulus.exhaustedAt

		expect(
			validatePersistedCommitEvidenceEnvelope(legacy, {
				stimulusId: entry.stimulus.stimulusId,
				stimulusType: entry.stimulus.type,
				journeyId: entry.decision.next.journeyId,
				actorVersion: 1,
				decidedAt: entry.decision.transitionReceipt.committedAt,
			}),
		).toMatchObject({ ok: false })
	})

	it.each([
		'CourseSequenceExhausted',
		'WakeDue',
		'DeliverySettled',
		'CouponIssued',
		'VerifiedUserObserved',
		'CouponBoundToUser',
		'ShadowNewsletterEntered',
		'PurchaseObserved',
		'UnsubscribeObserved',
		'SuppressionObserved',
		'OperatorStopObserved',
		'PermanentEffectRefusal',
	] as const)('rejects skeletal %s commit evidence', (stimulusType) => {
		const entry = start()
		const commit = {
			stimulus: entry.stimulus,
			expectedVersion: null,
			currentFacts: facts(),
			definition: EVERGREEN_OFFER_JOURNEY_V1,
			decidedAt: entry.decision.transitionReceipt.committedAt,
			decision: entry.decision,
		}
		const evidence = journeyCommitEvidenceRecord(commit)
		expect(
			validatePersistedCommitEvidenceEnvelope(
				{
					...evidence,
					stimulus: {
						type: stimulusType,
						stimulusId: entry.stimulus.stimulusId,
					},
				},
				{
					stimulusId: entry.stimulus.stimulusId,
					stimulusType,
					journeyId: entry.decision.next.journeyId,
					actorVersion: 1,
					decidedAt: entry.decision.transitionReceipt.committedAt,
				},
			),
		).toMatchObject({ ok: false })
	})
})

function instant(input: string) {
	return value(parseIsoInstant(input))
}

function value<Value>(result: ParseResult<Value>): Value {
	if (!result.ok) throw new Error(result.error.reason)
	return result.value
}
