import { Effect, Result } from 'effect'
import { describe, expect, it } from 'vitest'

import { deadlineTimeZoneEvidenceFromHeader } from './calendar'
import { decideEvergreenOfferJourney } from './decision'
import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import {
	EVERGREEN_OFFER_PRODUCT_ID,
	type EligibilityFacts,
	type EvergreenOfferJourneyAggregate,
	type EvergreenOfferStimulus,
	type JourneyDecision,
} from './domain'
import type { JourneyLedgerCommit } from './ports'
import {
	EVERGREEN_OFFER_JOURNEY_SNAPSHOT_FORMAT,
	encodeEvergreenOfferJourneySnapshot,
	restoreEvergreenOfferJourneySnapshot,
} from './restoration'
import {
	couponIntentKey,
	parseContactId,
	parseCouponId,
	parseEntryFactId,
	parseIanaTimeZone,
	parseIsoInstant,
	parseStimulusId,
	scheduleWakeId,
	type ParseResult,
} from './primitives'

const contactId = value(parseContactId('contact_ledger_test'))
const entryFactId = value(
	parseEntryFactId('course_sequence_exhausted_ledger_test'),
)
const exhaustedAt = instant('2026-09-04T17:00:00.000Z')
const timeZone = value(parseIanaTimeZone('America/Los_Angeles'))

function courseSequenceExhausted(
	stimulus = 'stimulus_ledger_entry',
): EvergreenOfferStimulus {
	const deadlineTimeZone = deadlineTimeZoneEvidenceFromHeader({
		headerValue: timeZone,
		capturedAt: exhaustedAt,
	})
	if (!deadlineTimeZone.ok) throw new Error(deadlineTimeZone.error.detail)
	return {
		type: 'CourseSequenceExhausted',
		stimulusId: value(parseStimulusId(stimulus)),
		entryFactId,
		contactId,
		valuePathId: 'ai-hero-skills-workflow-individual-v1',
		exhaustedAt,
		deadlineTimeZone: deadlineTimeZone.value,
		sourceReference: 'contact-event:course_sequence_exhausted_ledger_test',
	}
}

function facts(overrides: Partial<EligibilityFacts> = {}): EligibilityFacts {
	return {
		contactId,
		purchase: null,
		delivery: { type: 'Eligible' },
		existingJourneyId: null,
		automationControl: { type: 'Enabled', version: 'control-v1' },
		evidenceVersion: 'facts-v1',
		readAt: exhaustedAt,
		...overrides,
	}
}

function startDecision() {
	const stimulus = courseSequenceExhausted()
	const result = decideEvergreenOfferJourney({
		snapshot: null,
		stimulus,
		currentFacts: facts(),
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		now: exhaustedAt,
	})
	if (!result.ok || result.decision.type !== 'Accepted') {
		throw new Error('Expected an accepted entry decision')
	}
	return { stimulus, decision: result.decision }
}

function pitchedAggregate() {
	const { decision } = startDecision()
	const couponWake = decision.wakeIntents.find(
		(wake) => wake.purpose.type === 'CouponIssue',
	)
	if (!couponWake) throw new Error('Expected the coupon wake')
	const wakeStimulus: EvergreenOfferStimulus = {
		type: 'WakeDue',
		stimulusId: value(parseStimulusId('stimulus_codec_coupon_wake')),
		journeyId: decision.next.journeyId,
		wakeId: couponWake.wakeId,
		dueAt: couponWake.dueAt,
		purpose: couponWake.purpose,
	}
	const awaiting = decideEvergreenOfferJourney({
		snapshot: decision.next,
		stimulus: wakeStimulus,
		currentFacts: facts({ existingJourneyId: decision.next.journeyId }),
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		now: couponWake.dueAt,
	})
	if (!awaiting.ok || awaiting.decision.type !== 'Accepted') {
		throw new Error('Expected coupon issuance intent')
	}
	const intent = awaiting.decision.sideEffectIntents.find(
		(candidate) => candidate.type === 'IssueCoupon',
	)
	if (!intent || intent.type !== 'IssueCoupon') {
		throw new Error('Expected coupon issuance intent')
	}
	const coupon = {
		couponId: value(parseCouponId('coupon_codec_test')),
		contactId,
		issuedAt: intent.issueAt,
		expiresAt: intent.expiresAt,
		deadlineTimeZone: awaiting.decision.next.deadlineTimeZone,
		terms: intent.terms,
		binding: { type: 'AwaitingVerifiedUser' as const },
	}
	const issued = decideEvergreenOfferJourney({
		snapshot: awaiting.decision.next,
		stimulus: {
			type: 'CouponIssued',
			stimulusId: value(parseStimulusId('stimulus_codec_coupon_issued')),
			journeyId: decision.next.journeyId,
			intentKey: couponIntentKey(decision.next.journeyId),
			coupon,
		},
		currentFacts: facts({ existingJourneyId: decision.next.journeyId }),
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		now: coupon.issuedAt,
	})
	if (!issued.ok || issued.decision.type !== 'Accepted') {
		throw new Error('Expected pitch journey')
	}
	return issued.decision.next
}

function customerAggregate() {
	const { decision } = startDecision()
	const wake = decision.wakeIntents[0]!
	const purchaseAt = instant('2026-09-05T15:59:00.000Z')
	const purchased = decideEvergreenOfferJourney({
		snapshot: decision.next,
		stimulus: {
			type: 'WakeDue',
			stimulusId: value(parseStimulusId('stimulus_codec_purchase_wake')),
			journeyId: decision.next.journeyId,
			wakeId: wake.wakeId,
			dueAt: wake.dueAt,
			purpose: wake.purpose,
		},
		currentFacts: facts({
			existingJourneyId: decision.next.journeyId,
			purchase: {
				purchaseId: 'purchase_codec_test',
				offerProductFamily: 'ai-coding-crash-course',
				sourceProductId: EVERGREEN_OFFER_PRODUCT_ID,
				purchasedAt: purchaseAt,
				sourceReference: 'purchase:purchase_codec_test',
			},
		}),
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		now: wake.dueAt,
	})
	if (!purchased.ok || purchased.decision.type !== 'Accepted') {
		throw new Error('Expected customer journey')
	}
	return purchased.decision.next
}

function ledgerCommit(args: {
	stimulus: EvergreenOfferStimulus
	decision: Extract<JourneyDecision, { type: 'Accepted' }>
	expectedVersion: number | null
}): JourneyLedgerCommit {
	return {
		stimulus: args.stimulus,
		expectedVersion: args.expectedVersion,
		currentFacts: facts({
			existingJourneyId:
				args.expectedVersion === null ? null : args.decision.next.journeyId,
		}),
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		decidedAt: args.decision.transitionReceipt.committedAt,
		decision: args.decision,
	}
}

describe('evergreen offer journey restoration', () => {
	it('round trips a versioned aggregate snapshot', () => {
		const { decision } = startDecision()
		const encoded = encodeEvergreenOfferJourneySnapshot(decision.next)
		const restored = restoreEvergreenOfferJourneySnapshot(encoded)

		const persisted = JSON.parse(encoded)
		expect(persisted.format).toBe(EVERGREEN_OFFER_JOURNEY_SNAPSHOT_FORMAT)
		expect(persisted.aggregate.exhaustedAt).toBe(exhaustedAt)
		expect(persisted.aggregate).not.toHaveProperty('completedAt')
		expect(restored).toEqual({ ok: true, value: decision.next })
	})

	it('round trips coupon-bearing and final aggregate phases', () => {
		for (const aggregate of [pitchedAggregate(), customerAggregate()]) {
			expect(
				restoreEvergreenOfferJourneySnapshot(
					encodeEvergreenOfferJourneySnapshot(aggregate),
				),
			).toEqual({ ok: true, value: aggregate })
		}
	})

	it('rejects malformed JSON, unknown formats, and phase-invalid payloads', () => {
		const { decision } = startDecision()
		const envelope = JSON.parse(
			encodeEvergreenOfferJourneySnapshot(decision.next),
		)

		expect(restoreEvergreenOfferJourneySnapshot('{')).toMatchObject({
			ok: false,
			error: { type: 'JourneyDecodeFailure' },
		})
		expect(
			restoreEvergreenOfferJourneySnapshot(
				JSON.stringify({
					...envelope,
					format: 'evergreen-offer-journey.snapshot.v2',
				}),
			),
		).toMatchObject({
			ok: false,
			error: { type: 'JourneyDecodeFailure' },
		})
		expect(
			restoreEvergreenOfferJourneySnapshot(
				JSON.stringify({
					...envelope,
					aggregate: {
						...envelope.aggregate,
						phase: 'pitch.running',
						coupon: null,
					},
				}),
			),
		).toMatchObject({
			ok: false,
			error: { type: 'JourneyDecodeFailure' },
		})
	})

	it('rejects the retired completion name at the snapshot boundary', () => {
		const { decision } = startDecision()
		const legacy = JSON.parse(
			encodeEvergreenOfferJourneySnapshot(decision.next),
		)
		legacy.aggregate.completedAt = legacy.aggregate.exhaustedAt
		delete legacy.aggregate.exhaustedAt

		expect(
			restoreEvergreenOfferJourneySnapshot(JSON.stringify(legacy)),
		).toMatchObject({
			ok: false,
			error: { type: 'JourneyDecodeFailure' },
		})
	})

	it('rejects noncanonical fallback, schedules, and semantic intent keys', () => {
		const { decision } = startDecision()
		const encoded = encodeEvergreenOfferJourneySnapshot(decision.next)
		const fallback = JSON.parse(encoded)
		fallback.aggregate.deadlineTimeZone = {
			type: 'ExplicitFallback',
			reason: 'header-missing',
			timeZone: 'Europe/London',
			capturedAt: exhaustedAt,
		}
		const overlap = JSON.parse(encoded)
		overlap.aggregate.messagePlan.bridge[0].windowEndsAt =
			overlap.aggregate.messagePlan.bridge[2].windowEndsAt
		const semanticKey = JSON.parse(encoded)
		semanticKey.aggregate.messagePlan.bridge[0] = {
			...semanticKey.aggregate.messagePlan.bridge[0],
			status: 'IntentCommitted',
			intentKey: 'not-the-semantic-key',
			committedAt: semanticKey.aggregate.messagePlan.bridge[0].dueAt,
		}
		const droppedCoupon = JSON.parse(
			encodeEvergreenOfferJourneySnapshot(pitchedAggregate()),
		)
		droppedCoupon.aggregate.phase = 'stopped'
		droppedCoupon.aggregate.coupon = null
		droppedCoupon.aggregate.exit = {
			type: 'PermanentFailure',
			observedAt: droppedCoupon.aggregate.messagePlan.pitch[0].dueAt,
			reason: 'adversarial terminal snapshot',
		}
		droppedCoupon.aggregate.messagePlan.pitch[0].windowEndsAt =
			droppedCoupon.aggregate.messagePlan.pitch[4].windowEndsAt

		for (const invalid of [fallback, overlap, semanticKey, droppedCoupon]) {
			expect(
				restoreEvergreenOfferJourneySnapshot(JSON.stringify(invalid)),
			).toMatchObject({
				ok: false,
				error: { type: 'JourneyDecodeFailure' },
			})
		}
	})

	it('rejects envelope identity or actor-version drift', () => {
		const { decision } = startDecision()
		const envelope = JSON.parse(
			encodeEvergreenOfferJourneySnapshot(decision.next),
		)

		expect(
			restoreEvergreenOfferJourneySnapshot(
				JSON.stringify({
					...envelope,
					journeyId: 'evergreen-offer:another-entry',
				}),
			),
		).toMatchObject({
			ok: false,
			error: { type: 'JourneyDecodeFailure' },
		})
		expect(
			restoreEvergreenOfferJourneySnapshot(
				JSON.stringify({
					...envelope,
					actorVersion: envelope.actorVersion + 1,
				}),
			),
		).toMatchObject({
			ok: false,
			error: { type: 'JourneyDecodeFailure' },
		})
	})
})


function instant(input: string) {
	return value(parseIsoInstant(input))
}

function value<Value>(result: ParseResult<Value>): Value {
	if (!result.ok) throw new Error(JSON.stringify(result.error))
	return result.value
}
