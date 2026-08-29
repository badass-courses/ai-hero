import { describe, expect, it } from 'vitest'

import {
	couponExpiresAtForOpening,
	deadlineTimeZoneEvidenceFromHeader,
} from './calendar'
import { decideEvergreenOfferJourney } from './decision'
import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import type {
	DecideEvergreenOfferJourneyInput,
	EligibilityFacts,
	EvergreenOfferJourneyAggregate,
	EvergreenOfferStimulus,
	IssuedCoupon,
	JourneyDecision,
	ScheduleWakeIntent,
} from './domain'
import { EVERGREEN_OFFER_PRODUCT_ID } from './domain'
import { transitionJourneyPhase } from './phase-machine'
import {
	couponIntentKey,
	parseContactId,
	parseCouponId,
	parseEntryFactId,
	parseIanaTimeZone,
	parseIsoInstant,
	parseStimulusId,
	type ParseResult,
} from './primitives'

const contactId = value(parseContactId('contact_test'))
const entryFactId = value(parseEntryFactId('course_completed_test'))
const timeZone = value(parseIanaTimeZone('America/Los_Angeles'))
const completedAt = instant('2026-09-04T17:00:00.000Z')
const definition = EVERGREEN_OFFER_JOURNEY_V1

function facts(
	overrides: Partial<EligibilityFacts> = {},
): EligibilityFacts {
	return {
		contactId,
		purchase: null,
		delivery: { type: 'Eligible' },
		existingJourneyId: null,
		automationControl: { type: 'Enabled', version: 'control-v1' },
		evidenceVersion: 'facts-v1',
		readAt: completedAt,
		...overrides,
	}
}

function courseCompleted(): EvergreenOfferStimulus {
	const deadline = deadlineTimeZoneEvidenceFromHeader({
		headerValue: timeZone,
		capturedAt: completedAt,
	})
	if (!deadline.ok) throw new Error(deadline.error.detail)
	return {
		type: 'CourseCompleted',
		stimulusId: value(parseStimulusId('stimulus_course_completed')),
		entryFactId,
		contactId,
		valuePathId: 'ai-hero-skills-workflow-individual-v1',
		completedAt,
		deadlineTimeZone: deadline.value,
		sourceReference: 'contact-event:course_completed_test',
	}
}

function decide(args: {
	snapshot: EvergreenOfferJourneyAggregate | null
	stimulus: EvergreenOfferStimulus
	now: string
	currentFacts?: EligibilityFacts
}) {
	return decideEvergreenOfferJourney({
		snapshot: args.snapshot,
		stimulus: args.stimulus,
		currentFacts: args.currentFacts ?? facts(),
		definition,
		now: instant(args.now),
	})
}

function startJourney() {
	return accepted(
		decide({
			snapshot: null,
			stimulus: courseCompleted(),
			now: completedAt,
		}),
	)
}

function issueCoupon(snapshot: EvergreenOfferJourneyAggregate) {
	const couponWake = startJourney().wakeIntents.find(
		(intent) => intent.purpose.type === 'CouponIssue',
	)
	if (!couponWake) throw new Error('Coupon wake missing')
	const awaiting = accepted(
		decide({
			snapshot,
			stimulus: {
				type: 'WakeDue',
				stimulusId: value(parseStimulusId('stimulus_coupon_wake')),
				journeyId: snapshot.journeyId,
				wakeId: couponWake.wakeId,
				dueAt: couponWake.dueAt,
				purpose: couponWake.purpose,
			},
			now: couponWake.dueAt,
		}),
	)
	const couponIntent = awaiting.sideEffectIntents.find(
		(intent) => intent.type === 'IssueCoupon',
	)
	if (!couponIntent || couponIntent.type !== 'IssueCoupon') {
		throw new Error('Coupon intent missing')
	}
	const coupon: IssuedCoupon = {
		couponId: value(parseCouponId('coupon_test')),
		contactId,
		issuedAt: couponIntent.issueAt,
		expiresAt: couponIntent.expiresAt,
		deadlineTimeZone: snapshot.deadlineTimeZone,
		terms: definition.couponTerms,
		binding: { type: 'AwaitingVerifiedUser' },
	}
	const pitched = accepted(
		decide({
			snapshot: awaiting.next,
			stimulus: {
				type: 'CouponIssued',
				stimulusId: value(parseStimulusId('stimulus_coupon_issued')),
				journeyId: snapshot.journeyId,
				intentKey: couponIntentKey(snapshot.journeyId),
				coupon,
			},
			now: coupon.issuedAt,
		}),
	)
	return { awaiting, pitched, coupon }
}

describe('evergreen offer journey production core', () => {
	it('pins the approved message and presentation plan without provider IDs', () => {
		expect(definition.messagePlanId).toBe(
			'crash_course_evergreen_presentation_v1',
		)
		expect(definition.contentRevision).toBe(
			'1afe22601ccd5641cec04a4ad94963d6a816316f',
		)
		expect(
			[...definition.bridge, ...definition.pitch].map((message) => ({
				messageId: message.contentResourceId,
				bundleId: message.presentation.bundleId,
			})),
		).toEqual([
			{ messageId: 'bridge_can_engineer_v1', bundleId: 'direct_v1' },
			{ messageId: 'bridge_real_codebase_v1', bundleId: 'direct_v1' },
			{ messageId: 'bridge_keep_skills_v1', bundleId: 'direct_v1' },
			{ messageId: 'pitch_open_product_origin_v1', bundleId: 'direct_v1' },
			{ messageId: 'pitch_watch_feature_build_v1', bundleId: 'direct_v1' },
			{ messageId: 'pitch_self_paced_faq_v1', bundleId: 'direct_v1' },
			{ messageId: 'pitch_proof_last_day_v1', bundleId: 'direct_v1' },
			{ messageId: 'pitch_final_notice_v1', bundleId: 'direct_v1' },
		])
		expect(JSON.stringify(definition)).not.toContain('kitSequenceId')
	})

	it('captures exact browser time-zone evidence and explicit fallback evidence', () => {
		const browser = deadlineTimeZoneEvidenceFromHeader({
			headerValue: 'Asia/Tokyo',
			capturedAt: completedAt,
		})
		const fallback = deadlineTimeZoneEvidenceFromHeader({
			headerValue: 'Not/AZone',
			capturedAt: completedAt,
		})

		expect(browser.ok && browser.value.type).toBe('BrowserEntryHeader')
		expect(browser.ok && browser.value.timeZone).toBe('Asia/Tokyo')
		expect(fallback.ok && fallback.value.type).toBe('ExplicitFallback')
		expect(fallback.ok && fallback.value.timeZone).toBe(
			'America/Los_Angeles',
		)
	})

	it('starts one independent bridge plan and one coupon wake', () => {
		const started = startJourney()

		expect(started.next.phase).toBe('bridge.running')
		expect(started.next.messagePlan.bridge.map((slot) => slot.dueAt)).toEqual([
			'2026-09-05T16:00:00.000Z',
			'2026-09-06T16:00:00.000Z',
			'2026-09-07T16:00:00.000Z',
		])
		expect(started.wakeIntents).toHaveLength(4)
		expect(
			started.wakeIntents.find(
				(intent) => intent.purpose.type === 'CouponIssue',
			)?.dueAt,
		).toBe('2026-09-10T16:00:00.000Z')
	})

	it('lets B2 send on schedule after an ambiguous B1 receipt', () => {
		const started = startJourney()
		const [b1Wake, b2Wake] = started.wakeIntents
		const b1Committed = accepted(
			decide({
				snapshot: started.next,
				stimulus: wakeStimulus(started.next, b1Wake!, 'b1-wake'),
				now: b1Wake!.dueAt,
			}),
		)
		const b1Intent = b1Committed.sideEffectIntents[0]
		if (!b1Intent || b1Intent.type !== 'SendMessage') {
			throw new Error('B1 send intent missing')
		}
		const ambiguous = accepted(
			decide({
				snapshot: b1Committed.next,
				stimulus: {
					type: 'DeliverySettled',
					stimulusId: value(parseStimulusId('stimulus_b1_ambiguous')),
					journeyId: started.next.journeyId,
					slotId: b1Intent.slotId,
					intentKey: b1Intent.idempotencyKey,
					settledAt: instant('2026-09-05T16:01:00.000Z'),
					outcome: { type: 'Ambiguous', reason: 'provider timeout' },
				},
				now: '2026-09-05T16:01:00.000Z',
			}),
		)
		const b2 = accepted(
			decide({
				snapshot: ambiguous.next,
				stimulus: wakeStimulus(ambiguous.next, b2Wake!, 'b2-wake'),
				now: b2Wake!.dueAt,
			}),
		)

		expect(b2.sideEffectIntents).toHaveLength(1)
		expect(b2.next.messagePlan.bridge.map((slot) => slot.status)).toEqual([
			'Ambiguous',
			'IntentCommitted',
			'Scheduled',
		])
	})

	it('commits a stale message as missed without replaying it', () => {
		const started = startJourney()
		const b1Wake = started.wakeIntents[0]!
		const b2Wake = started.wakeIntents[1]!
		const missed = accepted(
			decide({
				snapshot: started.next,
				stimulus: wakeStimulus(started.next, b1Wake, 'late-b1-wake'),
				now: b2Wake.dueAt,
			}),
		)

		expect(missed.next.messagePlan.bridge[0].status).toBe('Missed')
		expect(missed.sideEffectIntents).toHaveLength(0)
		expect(missed.events.map((event) => event.type)).toEqual([
			'MessageMissed',
		])
	})

	it('suppresses a duplicate message wake after one intent was committed', () => {
		const started = startJourney()
		const b1Wake = started.wakeIntents[0]!
		const first = accepted(
			decide({
				snapshot: started.next,
				stimulus: wakeStimulus(started.next, b1Wake, 'b1-first'),
				now: b1Wake.dueAt,
			}),
		)
		const duplicate = decide({
			snapshot: first.next,
			stimulus: wakeStimulus(first.next, b1Wake, 'b1-duplicate'),
			now: b1Wake.dueAt,
		})

		expect(duplicate.ok).toBe(true)
		if (!duplicate.ok) return
		expect(duplicate.decision).toEqual({
			type: 'Ignored',
			reason: 'SlotIntentAlreadyCommitted',
			current: first.next,
		})
	})

	it('issues the coupon from its wake even when bridge slots were missed', () => {
		const started = startJourney()
		const { awaiting, pitched, coupon } = issueCoupon(started.next)

		expect(awaiting.next.phase).toBe('coupon.awaitingReceipt')
		expect(
			awaiting.next.messagePlan.bridge.map((slot) => slot.status),
		).toEqual(['Missed', 'Missed', 'Missed'])
		expect(coupon.expiresAt).toBe('2026-09-15T06:59:59.000Z')
		expect(pitched.next.phase).toBe('pitch.running')
		expect(pitched.next.messagePlan.pitch).toHaveLength(5)
		expect(pitched.wakeIntents).toHaveLength(6)
	})

	it('lets P3 send on schedule after a message-local P2 refusal', () => {
		const started = startJourney()
		const { pitched } = issueCoupon(started.next)
		const p2Wake = pitched.wakeIntents.find(
			(intent) =>
				intent.purpose.type === 'MessageSlot' &&
				intent.purpose.slotId === pitched.next.messagePlan.pitch[1]!.slotId,
		)!
		const p3Wake = pitched.wakeIntents.find(
			(intent) =>
				intent.purpose.type === 'MessageSlot' &&
				intent.purpose.slotId === pitched.next.messagePlan.pitch[2]!.slotId,
		)!
		const p2 = accepted(
			decide({
				snapshot: pitched.next,
				stimulus: wakeStimulus(pitched.next, p2Wake, 'p2-wake'),
				now: p2Wake.dueAt,
			}),
		)
		const p2Intent = p2.sideEffectIntents[0]
		if (!p2Intent || p2Intent.type !== 'SendMessage') {
			throw new Error('P2 intent missing')
		}
		const refused = accepted(
			decide({
				snapshot: p2.next,
				stimulus: {
					type: 'PermanentEffectRefusal',
					stimulusId: value(parseStimulusId('stimulus_p2_refused')),
					journeyId: p2.next.journeyId,
					intentKey: p2Intent.idempotencyKey,
					observedAt: instant('2026-09-11T16:01:00.000Z'),
					scope: 'MessageLocal',
					reason: 'provider refused one message',
					slotId: p2Intent.slotId,
				},
				now: '2026-09-11T16:01:00.000Z',
			}),
		)
		const p3 = accepted(
			decide({
				snapshot: refused.next,
				stimulus: wakeStimulus(refused.next, p3Wake, 'p3-wake'),
				now: p3Wake.dueAt,
			}),
		)

		expect(p3.sideEffectIntents).toHaveLength(1)
		expect(p3.next.messagePlan.pitch[1]!.status).toBe('Refused')
		expect(p3.next.messagePlan.pitch[2]!.status).toBe('IntentCommitted')
	})

	it('marks stale pitch slots missed and emits only the current message', () => {
		const started = startJourney()
		const { pitched } = issueCoupon(started.next)
		const p5Wake = pitched.wakeIntents.find(
			(intent) =>
				intent.purpose.type === 'MessageSlot' &&
				intent.purpose.slotId === pitched.next.messagePlan.pitch[4]!.slotId,
		)
		if (!p5Wake) throw new Error('P5 wake missing')
		const p5 = accepted(
			decide({
				snapshot: pitched.next,
				stimulus: wakeStimulus(pitched.next, p5Wake, 'p5-wake'),
				now: p5Wake.dueAt,
			}),
		)

		expect(p5.sideEffectIntents).toHaveLength(1)
		expect(p5.next.messagePlan.pitch.map((slot) => slot.status)).toEqual([
			'Missed',
			'Missed',
			'Missed',
			'Missed',
			'IntentCommitted',
		])
	})

	it('stops future work when current purchase authority reports ownership', () => {
		const started = startJourney()
		const b1Wake = started.wakeIntents[0]!
		const purchased = accepted(
			decide({
				snapshot: started.next,
				stimulus: wakeStimulus(started.next, b1Wake, 'purchase-stop-wake'),
				now: b1Wake.dueAt,
				currentFacts: facts({
					purchase: {
						purchaseId: 'purchase_test',
						productId: EVERGREEN_OFFER_PRODUCT_ID,
						purchasedAt: instant('2026-09-05T15:59:00.000Z'),
						sourceReference: 'purchase:purchase_test',
					},
				}),
			}),
		)

		expect(purchased.next.phase).toBe('customer')
		expect(purchased.sideEffectIntents).toHaveLength(0)
	})

	it('halts effects without rewriting actor state when global control is stopped', () => {
		const started = startJourney()
		const result = decide({
			snapshot: started.next,
			stimulus: wakeStimulus(
				started.next,
				started.wakeIntents[0]!,
				'automation-stop-wake',
			),
			now: started.wakeIntents[0]!.dueAt,
			currentFacts: facts({
				automationControl: {
					type: 'Stopped',
					version: 'control-v2',
					reason: 'operator stop',
				},
			}),
		})

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.decision.type).toBe('Ignored')
		if (result.decision.type === 'Ignored') {
			expect(result.decision.current?.phase).toBe('bridge.running')
		}
	})

	it('enters the Shadow Newsletter only after coupon expiry', () => {
		const started = startJourney()
		const { pitched, coupon } = issueCoupon(started.next)
		const expiryWake = pitched.wakeIntents.find(
			(intent) => intent.purpose.type === 'CouponExpiry',
		)
		if (!expiryWake) throw new Error('Expiry wake missing')
		const handoff = accepted(
			decide({
				snapshot: pitched.next,
				stimulus: wakeStimulus(pitched.next, expiryWake, 'expiry-wake'),
				now: coupon.expiresAt,
			}),
		)

		expect(handoff.next.phase).toBe('handoff.awaitingReceipt')
		expect(handoff.sideEffectIntents).toEqual([
			expect.objectContaining({ type: 'EnterShadowNewsletter' }),
		])
	})

	it('rejects a coupon window that disagrees with Monday expiry authority', () => {
		const started = startJourney()
		const couponWake = started.wakeIntents.find(
			(intent) => intent.purpose.type === 'CouponIssue',
		)!
		const awaiting = accepted(
			decide({
				snapshot: started.next,
				stimulus: wakeStimulus(started.next, couponWake, 'coupon-wake-bad'),
				now: couponWake.dueAt,
			}),
		)
		const coupon: IssuedCoupon = {
			couponId: value(parseCouponId('coupon_bad_window')),
			contactId,
			issuedAt: couponWake.dueAt,
			expiresAt: instant('2026-09-15T07:00:00.000Z'),
			deadlineTimeZone: started.next.deadlineTimeZone,
			terms: definition.couponTerms,
			binding: { type: 'AwaitingVerifiedUser' },
		}
		const result = decide({
			snapshot: awaiting.next,
			stimulus: {
				type: 'CouponIssued',
				stimulusId: value(parseStimulusId('stimulus_bad_coupon')),
				journeyId: awaiting.next.journeyId,
				intentKey: couponIntentKey(awaiting.next.journeyId),
				coupon,
			},
			now: coupon.issuedAt,
		})

		expect(result).toEqual({
			ok: false,
			error: {
				type: 'ScheduleInvalid',
				reason:
					'Coupon expiry does not match Monday 23:59:59 in the pinned time zone',
			},
		})
	})

	it('keeps phase topology finite and rejects invalid transitions', () => {
		expect(
			transitionJourneyPhase({
				from: 'bridge.running',
				event: { type: 'COUPON_WAKE' },
			}),
		).toEqual({ ok: true, phase: 'coupon.awaitingReceipt' })
		expect(
			transitionJourneyPhase({
				from: 'bridge.running',
				event: { type: 'SHADOW_ENTERED' },
			}),
		).toEqual({
			ok: false,
			from: 'bridge.running',
			event: 'SHADOW_ENTERED',
		})
	})

	it('derives expiry from the pinned coupon time zone', () => {
		expect(
			couponExpiresAtForOpening({
				openingAt: instant('2026-10-29T16:00:00.000Z'),
				timeZone,
			}),
		).toBe('2026-11-03T07:59:59.000Z')
	})
})

function wakeStimulus(
	snapshot: EvergreenOfferJourneyAggregate,
	wake: ScheduleWakeIntent,
	suffix: string,
): EvergreenOfferStimulus {
	return {
		type: 'WakeDue',
		stimulusId: value(parseStimulusId(`stimulus_${suffix}`)),
		journeyId: snapshot.journeyId,
		wakeId: wake.wakeId,
		dueAt: wake.dueAt,
		purpose: wake.purpose,
	}
}

function accepted(
	result: ReturnType<typeof decideEvergreenOfferJourney>,
): Extract<JourneyDecision, { type: 'Accepted' }> {
	if (!result.ok) throw new Error(result.error.reason)
	if (result.decision.type !== 'Accepted') {
		throw new Error(`Expected Accepted, received ${result.decision.type}`)
	}
	return result.decision
}

function instant(input: string) {
	return value(parseIsoInstant(input))
}

function value<Value>(result: ParseResult<Value>): Value {
	if (!result.ok) throw new Error(result.error.reason)
	return result.value
}
