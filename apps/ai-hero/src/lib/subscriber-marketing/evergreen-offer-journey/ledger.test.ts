import { Effect, Either } from 'effect'
import { describe, expect, it } from 'vitest'

import {
	deadlineTimeZoneEvidenceFromHeader,
	decideEvergreenOfferJourney,
	EVERGREEN_OFFER_JOURNEY_V1,
	EVERGREEN_OFFER_PRODUCT_ID,
} from '.'
import type {
	EligibilityFacts,
	EvergreenOfferJourneyAggregate,
	EvergreenOfferStimulus,
	JourneyDecision,
} from './domain'
import { makeInMemoryJourneyLedger } from './in-memory-ledger'
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
const entryFactId = value(parseEntryFactId('course_completed_ledger_test'))
const completedAt = instant('2026-09-04T17:00:00.000Z')
const timeZone = value(parseIanaTimeZone('America/Los_Angeles'))

function courseCompleted(
	stimulus = 'stimulus_ledger_entry',
): EvergreenOfferStimulus {
	const deadlineTimeZone = deadlineTimeZoneEvidenceFromHeader({
		headerValue: timeZone,
		capturedAt: completedAt,
	})
	if (!deadlineTimeZone.ok) throw new Error(deadlineTimeZone.error.detail)
	return {
		type: 'CourseCompleted',
		stimulusId: value(parseStimulusId(stimulus)),
		entryFactId,
		contactId,
		valuePathId: 'ai-hero-skills-workflow-individual-v1',
		completedAt,
		deadlineTimeZone: deadlineTimeZone.value,
		sourceReference: 'contact-event:course_completed_ledger_test',
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
		readAt: completedAt,
		...overrides,
	}
}

function startDecision() {
	const stimulus = courseCompleted()
	const result = decideEvergreenOfferJourney({
		snapshot: null,
		stimulus,
		currentFacts: facts(),
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		now: completedAt,
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

		expect(JSON.parse(encoded).format).toBe(
			EVERGREEN_OFFER_JOURNEY_SNAPSHOT_FORMAT,
		)
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

	it('rejects noncanonical fallback, schedules, and semantic intent keys', () => {
		const { decision } = startDecision()
		const encoded = encodeEvergreenOfferJourneySnapshot(decision.next)
		const fallback = JSON.parse(encoded)
		fallback.aggregate.deadlineTimeZone = {
			type: 'ExplicitFallback',
			reason: 'header-missing',
			timeZone: 'Europe/London',
			capturedAt: completedAt,
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

describe('in-memory journey ledger contract', () => {
	it('commits and restores one aggregate through the snapshot codec', async () => {
		const ledger = makeInMemoryJourneyLedger()
		const { stimulus, decision } = startDecision()
		const committed = await Effect.runPromise(
			ledger.commit(
				ledgerCommit({ stimulus, decision, expectedVersion: null }),
			),
		)
		const loaded = await Effect.runPromise(ledger.load(decision.next.journeyId))
		const records = ledger.records()

		expect(committed).toEqual({
			decision,
			committed: true,
			replayedStimulus: false,
		})
		expect(loaded).toEqual(decision.next)
		expect(records.snapshots).toHaveLength(1)
		expect(records.events).toHaveLength(decision.events.length)
		expect(records.wakes).toHaveLength(decision.wakeIntents.length)
		expect(records.wakes.every((wake) => wake.status === 'Pending')).toBe(true)
		expect(records.stimuli).toHaveLength(1)
	})

	it('replays the original committed decision for a duplicate stimulus', async () => {
		const ledger = makeInMemoryJourneyLedger()
		const { stimulus, decision } = startDecision()
		const commit = ledgerCommit({ stimulus, decision, expectedVersion: null })
		const first = await Effect.runPromise(ledger.commit(commit))
		if (first.decision.type !== 'Accepted')
			throw new Error('Expected accepted commit')
		Reflect.set(first.decision.next, 'version', 999)
		const exposedRecords = ledger.records()
		const exposedDecision = exposedRecords.stimuli[0]!.decision.decision
		if (exposedDecision.type !== 'Accepted') {
			throw new Error('Expected accepted stored decision')
		}
		Reflect.set(exposedDecision.next, 'version', 777)
		const replay = await Effect.runPromise(ledger.commit(commit))
		const found = await Effect.runPromise(
			ledger.findCommittedStimulus(stimulus.stimulusId),
		)

		expect(replay).toEqual({
			decision,
			committed: false,
			replayedStimulus: true,
		})
		expect(found).toEqual({
			decision,
			committed: true,
			replayedStimulus: false,
		})
		expect(ledger.records().snapshots).toHaveLength(1)
		expect(ledger.records().events).toHaveLength(decision.events.length)
	})

	it('rejects decisions and wakes that do not match the committed stimulus', async () => {
		const { stimulus, decision } = startDecision()
		const purchaseLedger = makeInMemoryJourneyLedger()
		await Effect.runPromise(
			purchaseLedger.commit(
				ledgerCommit({ stimulus, decision, expectedVersion: null }),
			),
		)
		const purchasedAt = instant('2026-09-05T16:00:00.000Z')
		const purchaseStimulus: EvergreenOfferStimulus = {
			type: 'PurchaseObserved',
			stimulusId: value(parseStimulusId('stimulus_adversarial_purchase')),
			journeyId: decision.next.journeyId,
			purchase: {
				purchaseId: 'purchase_adversarial',
				offerProductFamily: 'ai-coding-crash-course',
				sourceProductId: EVERGREEN_OFFER_PRODUCT_ID,
				purchasedAt,
				sourceReference: 'purchase:purchase_adversarial',
			},
		}
		const fakePurchaseDecision: Extract<JourneyDecision, { type: 'Accepted' }> =
			{
				...decision,
				next: { ...decision.next, version: 2 },
				events: [],
				sideEffectIntents: [],
				wakeIntents: [],
				transitionReceipt: {
					stimulusId: purchaseStimulus.stimulusId,
					journeyId: decision.next.journeyId,
					from: 'bridge.running',
					to: 'bridge.running',
					committedAt: purchasedAt,
					evidenceVersion: 'facts-v1',
				},
			}
		const purchaseResult = await Effect.runPromise(
			Effect.either(
				purchaseLedger.commit({
					...ledgerCommit({
						stimulus: purchaseStimulus,
						decision: fakePurchaseDecision,
						expectedVersion: 1,
					}),
					decidedAt: purchasedAt,
				}),
			),
		)

		expect(Either.isLeft(purchaseResult)).toBe(true)
		if (Either.isLeft(purchaseResult)) {
			expect(purchaseResult.left.type).toBe('JourneyConstraintViolation')
		}
		expect(purchaseLedger.records().snapshots).toHaveLength(1)

		const wakeLedger = makeInMemoryJourneyLedger()
		const fakeWakeDecision: Extract<JourneyDecision, { type: 'Accepted' }> = {
			...decision,
			wakeIntents: [
				{
					...decision.wakeIntents[0]!,
					wakeId: scheduleWakeId({
						journeyId: decision.next.journeyId,
						semanticStepId: 'fake-expiry',
					}),
					purpose: { type: 'CouponExpiry' },
				},
				...decision.wakeIntents.slice(1),
			],
		}
		const wakeResult = await Effect.runPromise(
			Effect.either(
				wakeLedger.commit({
					...ledgerCommit({ stimulus, decision, expectedVersion: null }),
					decision: fakeWakeDecision,
				}),
			),
		)

		expect(Either.isLeft(wakeResult)).toBe(true)
		if (Either.isLeft(wakeResult)) {
			expect(wakeResult.left.type).toBe('JourneyConstraintViolation')
		}
		expect(wakeLedger.records().snapshots).toEqual([])
	})

	it('rejects stale expected versions without partially mutating records', async () => {
		const ledger = makeInMemoryJourneyLedger()
		const { stimulus, decision } = startDecision()
		await Effect.runPromise(
			ledger.commit(
				ledgerCommit({ stimulus, decision, expectedVersion: null }),
			),
		)
		const wake = decision.wakeIntents[0]!
		const wakeStimulus: EvergreenOfferStimulus = {
			type: 'WakeDue',
			stimulusId: value(parseStimulusId('stimulus_stale_wake')),
			journeyId: decision.next.journeyId,
			wakeId: wake.wakeId,
			dueAt: wake.dueAt,
			purpose: wake.purpose,
		}
		const next = decideEvergreenOfferJourney({
			snapshot: decision.next,
			stimulus: wakeStimulus,
			currentFacts: facts({ existingJourneyId: decision.next.journeyId }),
			definition: EVERGREEN_OFFER_JOURNEY_V1,
			now: wake.dueAt,
		})
		if (!next.ok || next.decision.type !== 'Accepted') {
			throw new Error('Expected an accepted wake decision')
		}
		const before = ledger.records()
		const stale = await Effect.runPromise(
			Effect.either(
				ledger.commit(
					ledgerCommit({
						stimulus: wakeStimulus,
						decision: next.decision,
						expectedVersion: 0,
					}),
				),
			),
		)

		expect(Either.isLeft(stale)).toBe(true)
		if (Either.isLeft(stale)) {
			expect(stale.left).toEqual({
				type: 'JourneyVersionConflict',
				journeyId: decision.next.journeyId,
			})
		}
		expect(ledger.records()).toEqual(before)
	})

	it('settles the matching intent when a provider receipt is committed', async () => {
		const ledger = makeInMemoryJourneyLedger()
		const { stimulus, decision } = startDecision()
		await Effect.runPromise(
			ledger.commit(
				ledgerCommit({ stimulus, decision, expectedVersion: null }),
			),
		)
		const wake = decision.wakeIntents[0]!
		const wakeStimulus: EvergreenOfferStimulus = {
			type: 'WakeDue',
			stimulusId: value(parseStimulusId('stimulus_receipt_wake')),
			journeyId: decision.next.journeyId,
			wakeId: wake.wakeId,
			dueAt: wake.dueAt,
			purpose: wake.purpose,
		}
		const intentDecision = decideEvergreenOfferJourney({
			snapshot: decision.next,
			stimulus: wakeStimulus,
			currentFacts: facts({ existingJourneyId: decision.next.journeyId }),
			definition: EVERGREEN_OFFER_JOURNEY_V1,
			now: wake.dueAt,
		})
		if (!intentDecision.ok || intentDecision.decision.type !== 'Accepted') {
			throw new Error('Expected message intent')
		}
		await Effect.runPromise(
			ledger.commit(
				ledgerCommit({
					stimulus: wakeStimulus,
					decision: intentDecision.decision,
					expectedVersion: 1,
				}),
			),
		)
		const intent = intentDecision.decision.sideEffectIntents[0]
		if (intent?.type !== 'SendMessage') throw new Error('Expected send intent')
		const settledAt = instant('2026-09-05T16:01:00.000Z')
		const deliveryStimulus: EvergreenOfferStimulus = {
			type: 'DeliverySettled',
			stimulusId: value(parseStimulusId('stimulus_delivery_applied')),
			journeyId: decision.next.journeyId,
			slotId: intent.slotId,
			intentKey: intent.idempotencyKey,
			settledAt,
			outcome: { type: 'Applied', providerReceiptId: 'provider_receipt_1' },
		}
		const receiptDecision = decideEvergreenOfferJourney({
			snapshot: intentDecision.decision.next,
			stimulus: deliveryStimulus,
			currentFacts: facts({ existingJourneyId: decision.next.journeyId }),
			definition: EVERGREEN_OFFER_JOURNEY_V1,
			now: settledAt,
		})
		if (!receiptDecision.ok || receiptDecision.decision.type !== 'Accepted') {
			throw new Error('Expected delivery receipt decision')
		}
		await Effect.runPromise(
			ledger.commit(
				ledgerCommit({
					stimulus: deliveryStimulus,
					decision: receiptDecision.decision,
					expectedVersion: 2,
				}),
			),
		)

		expect(ledger.records().intents).toEqual([
			expect.objectContaining({
				idempotencyKey: intent.idempotencyKey,
				status: 'Applied',
				settledByStimulusId: deliveryStimulus.stimulusId,
			}),
		])
		const view = await Effect.runPromise(
			ledger.inspect({
				journeyId: decision.next.journeyId,
				now: settledAt,
				automationControl: 'Enabled',
			}),
		)
		expect(view.operationalStatus).toBe('active')
		expect(view.intents).toEqual([
			expect.objectContaining({ status: 'applied', intent }),
		])
		expect(view.wakes).toContainEqual(
			expect.objectContaining({ status: 'applied', wake }),
		)
		expect(view.transitionReceipts).toHaveLength(3)
	})

	it('rejects duplicate semantic intent keys without partially mutating records', async () => {
		const ledger = makeInMemoryJourneyLedger()
		const { stimulus, decision } = startDecision()
		await Effect.runPromise(
			ledger.commit(
				ledgerCommit({ stimulus, decision, expectedVersion: null }),
			),
		)
		const wake = decision.wakeIntents[0]!
		const wakeStimulus: EvergreenOfferStimulus = {
			type: 'WakeDue',
			stimulusId: value(parseStimulusId('stimulus_first_intent')),
			journeyId: decision.next.journeyId,
			wakeId: wake.wakeId,
			dueAt: wake.dueAt,
			purpose: wake.purpose,
		}
		const first = decideEvergreenOfferJourney({
			snapshot: decision.next,
			stimulus: wakeStimulus,
			currentFacts: facts({ existingJourneyId: decision.next.journeyId }),
			definition: EVERGREEN_OFFER_JOURNEY_V1,
			now: wake.dueAt,
		})
		if (!first.ok || first.decision.type !== 'Accepted') {
			throw new Error('Expected the first message intent')
		}
		await Effect.runPromise(
			ledger.commit(
				ledgerCommit({
					stimulus: wakeStimulus,
					decision: first.decision,
					expectedVersion: 1,
				}),
			),
		)
		const duplicateStimulus = value(
			parseStimulusId('stimulus_duplicate_intent'),
		)
		const duplicateDecision: Extract<JourneyDecision, { type: 'Accepted' }> = {
			...first.decision,
			next: { ...first.decision.next, version: 3 },
			transitionReceipt: {
				...first.decision.transitionReceipt,
				stimulusId: duplicateStimulus,
				from: first.decision.next.phase,
			},
		}
		const before = ledger.records()
		const duplicate = await Effect.runPromise(
			Effect.either(
				ledger.commit({
					...ledgerCommit({
						stimulus: { ...wakeStimulus, stimulusId: duplicateStimulus },
						decision: duplicateDecision,
						expectedVersion: 2,
					}),
					decision: { ...duplicateDecision, wakeIntents: [] },
				}),
			),
		)

		expect(Either.isLeft(duplicate)).toBe(true)
		if (Either.isLeft(duplicate)) {
			expect(duplicate.left.type).toBe('JourneyConstraintViolation')
		}
		expect(ledger.records()).toEqual(before)
	})

	it('rejects a typed snapshot that cannot survive restoration', async () => {
		const ledger = makeInMemoryJourneyLedger()
		const { stimulus, decision } = startDecision()
		const [b1, b2, b3] = decision.next.messagePlan.bridge
		const invalidNext: EvergreenOfferJourneyAggregate = {
			...decision.next,
			messagePlan: {
				...decision.next.messagePlan,
				bridge: [{ ...b1, windowEndsAt: b1.dueAt }, b2, b3],
			},
		}
		const invalid = await Effect.runPromise(
			Effect.either(
				ledger.commit({
					...ledgerCommit({ stimulus, decision, expectedVersion: null }),
					decision: { ...decision, next: invalidNext },
				}),
			),
		)

		expect(Either.isLeft(invalid)).toBe(true)
		if (Either.isLeft(invalid)) {
			expect(invalid.left.type).toBe('JourneyConstraintViolation')
		}
		expect(ledger.records().snapshots).toEqual([])
	})

	it('returns a read-only projection without exposing final journey slots', async () => {
		const ledger = makeInMemoryJourneyLedger()
		const { stimulus, decision } = startDecision()
		await Effect.runPromise(
			ledger.commit(
				ledgerCommit({ stimulus, decision, expectedVersion: null }),
			),
		)
		const view = await Effect.runPromise(
			ledger.inspect({
				journeyId: decision.next.journeyId,
				now: completedAt,
				automationControl: 'Enabled',
			}),
		)

		expect(view.aggregate).toEqual(decision.next)
		expect(view.operationalStatus).toBe('active')
		expect(view.intents).toEqual([])
		expect(view.wakes).toHaveLength(decision.wakeIntents.length)
		expect(view.transitionReceipts).toEqual([decision.transitionReceipt])
		expect(view.evidenceVersion).toBe(`in-memory:${decision.next.version}`)

		const due = await Effect.runPromise(
			ledger.inspect({
				journeyId: decision.next.journeyId,
				now: decision.next.messagePlan.bridge[0].dueAt,
				automationControl: 'Enabled',
			}),
		)
		const halted = await Effect.runPromise(
			ledger.inspect({
				journeyId: decision.next.journeyId,
				now: decision.next.messagePlan.bridge[0].dueAt,
				automationControl: 'Stopped',
			}),
		)
		expect(due.nextOpenSlots.map((slot) => slot.slotId)).toEqual(['B1'])
		expect(halted.operationalStatus).toBe('halted')
	})

	it('returns a decode failure when seeded snapshot bytes are corrupt', async () => {
		const { decision } = startDecision()
		const ledger = makeInMemoryJourneyLedger({
			seed: {
				snapshots: [
					{
						format: EVERGREEN_OFFER_JOURNEY_SNAPSHOT_FORMAT,
						journeyId: decision.next.journeyId,
						actorVersion: decision.next.version,
						snapshotJson: '{',
					},
				],
			},
		})
		const loaded = await Effect.runPromise(
			Effect.either(ledger.load(decision.next.journeyId)),
		)

		expect(Either.isLeft(loaded)).toBe(true)
		if (Either.isLeft(loaded)) {
			expect(loaded.left.type).toBe('JourneyDecodeFailure')
		}
	})
})

function instant(input: string) {
	return value(parseIsoInstant(input))
}

function value<Value>(result: ParseResult<Value>): Value {
	if (!result.ok) throw new Error(JSON.stringify(result.error))
	return result.value
}
