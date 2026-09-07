import { Effect, Either } from 'effect'
import { describe, expect, it } from 'vitest'

import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import type {
	CourseSequenceExhausted,
	EligibilityFacts,
	EvergreenOfferStimulus,
} from './domain'
import type { JourneyLedger } from './ports'
import { makeInMemoryJourneyLedger } from './in-memory-ledger'
import {
	parseContactId,
	parseEntryFactId,
	parseIanaTimeZone,
	parseIsoInstant,
	parseStimulusId,
	type ParseResult,
} from './primitives'
import { createEvergreenOfferJourneyService } from './service'

function value<T>(result: ParseResult<T>): T {
	if (!result.ok) throw new Error('Invalid test fixture')
	return result.value
}
const at = value(parseIsoInstant('2026-09-04T17:00:00.000Z'))
const contactId = value(parseContactId('service-contact'))
const stimulus: CourseSequenceExhausted = {
	type: 'CourseSequenceExhausted',
	stimulusId: value(parseStimulusId('entry-fact')),
	entryFactId: value(parseEntryFactId('entry-fact')),
	contactId,
	valuePathId: 'ai-hero-skills-workflow-individual-v1',
	exhaustedAt: at,
	deadlineTimeZone: {
		type: 'ExplicitFallback',
		reason: 'header-missing',
		timeZone: value(parseIanaTimeZone('America/Los_Angeles')),
		capturedAt: at,
	},
	sourceReference: 'side-effect-intent:prior-intent',
}
function facts(overrides: Partial<EligibilityFacts> = {}): EligibilityFacts {
	return {
		contactId,
		purchase: null,
		delivery: { type: 'Eligible' },
		existingJourneyId: null,
		automationControl: { type: 'Enabled', version: 'control-v1' },
		evidenceVersion: 'facts-v1',
		readAt: at,
		...overrides,
	}
}

describe('Evergreen application service', () => {
	it('does not commit entry or effects while control is stopped', async () => {
		const ledger = makeInMemoryJourneyLedger()
		const service = createEvergreenOfferJourneyService({
			ledger,
			authority: {
				currentFacts: () =>
					Effect.succeed(
						facts({
							automationControl: {
								type: 'Stopped',
								version: 'control-v1',
								reason: 'operator-stop',
							},
						}),
					),
			},
			clock: { now: Effect.succeed(at) },
			definition: EVERGREEN_OFFER_JOURNEY_V1,
		})
		const result = await Effect.runPromise(service.advance(stimulus))
		expect(result.committed).toBe(false)
		expect(result.decision).toMatchObject({
			type: 'Ignored',
			reason: 'EntryIneligible',
		})
		expect(
			await Effect.runPromise(
				ledger.findCommittedStimulus(stimulus.stimulusId),
			),
		).toBeNull()
	})
	it('replays the same fact without a second commit and rejects altered evidence', async () => {
		const ledger = makeInMemoryJourneyLedger()
		const service = createEvergreenOfferJourneyService({
			ledger,
			authority: {
				currentFacts: ({ journeyId }) =>
					Effect.succeed(facts({ existingJourneyId: journeyId })),
			},
			clock: { now: Effect.succeed(at) },
			definition: EVERGREEN_OFFER_JOURNEY_V1,
		})
		const first = await Effect.runPromise(service.advance(stimulus))
		const replay = await Effect.runPromise(
			service.advance(structuredClone(stimulus)),
		)
		expect(first.committed).toBe(true)
		expect(replay).toEqual({
			...first,
			committed: false,
			replayedStimulus: true,
		})
		for (const altered of [
			{ ...stimulus, contactId: value(parseContactId('other-contact')) },
			{ ...stimulus, sourceReference: 'side-effect-intent:another' },
			{
				...stimulus,
				deadlineTimeZone: {
					...stimulus.deadlineTimeZone,
					capturedAt: value(parseIsoInstant('2026-09-04T16:00:00.000Z')),
				},
			},
		]) {
			const result = await Effect.runPromise(
				Effect.either(service.advance(altered)),
			)
			expect(Either.isLeft(result)).toBe(true)
		}
		expect(ledger.records().stimuli).toHaveLength(1)
	})
	it('fails closed for missing control and invalid entry evidence', async () => {
		const ledger = makeInMemoryJourneyLedger()
		const service = createEvergreenOfferJourneyService({
			ledger,
			authority: {
				currentFacts: () =>
					Effect.succeed({
						...facts(),
						automationControl: undefined,
					} as unknown as EligibilityFacts),
			},
			clock: { now: Effect.succeed(at) },
			definition: EVERGREEN_OFFER_JOURNEY_V1,
		})
		const missingControl = await Effect.runPromise(
			Effect.either(service.advance(stimulus)),
		)
		expect(Either.isLeft(missingControl)).toBe(true)
		const validAuthorityService = createEvergreenOfferJourneyService({
			ledger,
			authority: { currentFacts: () => Effect.succeed(facts()) },
			clock: { now: Effect.succeed(at) },
			definition: EVERGREEN_OFFER_JOURNEY_V1,
		})
		for (const input of [
			{ ...stimulus, type: 'course.completed' },
			{ ...stimulus, sourceReference: '' },
			{
				...stimulus,
				deadlineTimeZone: {
					...stimulus.deadlineTimeZone,
					timeZone: 'Mars/Olympus',
				},
			},
			{ ...stimulus, stimulusId: 'different-fact' },
		]) {
			const result = await Effect.runPromise(
				Effect.either(
					validAuthorityService.advance(input as EvergreenOfferStimulus),
				),
			)
			expect(Either.isLeft(result) && result.left.type).toBe(
				'JourneyDecodeFailure',
			)
		}
		expect(ledger.records().stimuli).toHaveLength(0)
	})

	it('reloads authority after a CAS conflict and bounds repeated conflicts', async () => {
		const base = makeInMemoryJourneyLedger()
		let attempts = 0
		let stopped = false
		const ledger: JourneyLedger = {
			...base,
			commit: (candidate) =>
				Effect.suspend(() => {
					attempts++
					stopped = true
					return Effect.fail({
						type: 'JourneyVersionConflict' as const,
						journeyId: candidate.decision.next.journeyId,
					})
				}),
		}
		const service = createEvergreenOfferJourneyService({
			ledger,
			authority: {
				currentFacts: () =>
					Effect.sync(() =>
						facts(
							stopped
								? {
										automationControl: {
											type: 'Stopped',
											version: 'v2',
											reason: 'stop',
										},
									}
								: {},
						),
					),
			},
			clock: { now: Effect.succeed(at) },
			definition: EVERGREEN_OFFER_JOURNEY_V1,
		})
		const stoppedResult = await Effect.runPromise(service.advance(stimulus))
		expect(stoppedResult.decision).toMatchObject({
			type: 'Ignored',
			reason: 'EntryIneligible',
		})
		expect(attempts).toBe(1)
		attempts = 0
		const alwaysConflicts = createEvergreenOfferJourneyService({
			ledger,
			authority: { currentFacts: () => Effect.succeed(facts()) },
			clock: { now: Effect.succeed(at) },
			definition: EVERGREEN_OFFER_JOURNEY_V1,
		})
		const result = await Effect.runPromise(
			Effect.either(alwaysConflicts.advance(stimulus)),
		)
		expect(Either.isLeft(result) && result.left.type).toBe(
			'JourneyVersionConflict',
		)
		expect(attempts).toBe(3)
		expect(base.records().stimuli).toHaveLength(0)
	})
	it.each([
		[
			'purchase',
			{
				purchase: {
					purchaseId: 'purchase',
					offerProductFamily: 'ai-coding-crash-course',
					sourceProductId: 'product-ma254',
					purchasedAt: at,
					sourceReference: 'purchase:verified',
				},
			},
			'Purchased',
		],
		[
			'unsubscribe',
			{ delivery: { type: 'Unsubscribed', evidence: 'provider:unsubscribe' } },
			'Unsubscribed',
		],
		[
			'suppression',
			{ delivery: { type: 'Suppressed', evidence: 'provider:suppressed' } },
			'Suppressed',
		],
	] as const)(
		'uses current %s authority to stop a due transition',
		async (_name, change, reason) => {
			const ledger = makeInMemoryJourneyLedger()
			let current: Partial<EligibilityFacts> = {}
			let now = at
			const service = createEvergreenOfferJourneyService({
				ledger,
				authority: {
					currentFacts: ({ journeyId }) =>
						Effect.sync(() =>
							facts({ existingJourneyId: journeyId, ...current }),
						),
				},
				clock: { now: Effect.sync(() => now) },
				definition: EVERGREEN_OFFER_JOURNEY_V1,
			})
			const start = await Effect.runPromise(service.advance(stimulus))
			if (start.decision.type !== 'Accepted') throw new Error('Expected entry')
			const wake = start.decision.wakeIntents[0]!
			now = wake.dueAt
			current = change
			const result = await Effect.runPromise(
				service.advance({
					type: 'WakeDue',
					stimulusId: value(parseStimulusId('wake')),
					journeyId: wake.journeyId,
					wakeId: wake.wakeId,
					dueAt: wake.dueAt,
					purpose: wake.purpose,
				}),
			)
			expect(result.decision).toMatchObject({
				type: 'Accepted',
				next: { exit: { type: reason } },
				sideEffectIntents: [],
			})
			expect(ledger.records().intents).toHaveLength(0)
		},
	)

	it('commits concurrent duplicate entry only once and inspection never writes', async () => {
		const ledger = makeInMemoryJourneyLedger()
		const service = createEvergreenOfferJourneyService({
			ledger,
			authority: {
				currentFacts: ({ journeyId }) =>
					Effect.succeed(facts({ existingJourneyId: journeyId })),
			},
			clock: { now: Effect.succeed(at) },
			definition: EVERGREEN_OFFER_JOURNEY_V1,
		})
		const results = await Effect.runPromise(
			Effect.all([service.advance(stimulus), service.advance(stimulus)], {
				concurrency: 2,
			}),
		)
		expect(results.filter((result) => result.committed)).toHaveLength(1)
		expect(ledger.records().stimuli).toHaveLength(1)
		const result = results[0]!
		if (result.decision.type !== 'Accepted') throw new Error('Expected entry')
		const before = ledger.records()
		await Effect.runPromise(service.inspect(result.decision.next.journeyId))
		expect(ledger.records()).toEqual(before)
	})

	it('does not retry authority failures or mismatched identities', async () => {
		const ledger = makeInMemoryJourneyLedger()
		let reads = 0
		const service = createEvergreenOfferJourneyService({
			ledger,
			authority: {
				currentFacts: () =>
					Effect.suspend(() => {
						reads++
						return Effect.fail({
							type: 'AuthorityUnavailable',
							reason: 'offline',
						})
					}),
			},
			clock: { now: Effect.succeed(at) },
			definition: EVERGREEN_OFFER_JOURNEY_V1,
		})
		expect(
			Either.isLeft(
				await Effect.runPromise(Effect.either(service.advance(stimulus))),
			),
		).toBe(true)
		expect(reads).toBe(1)
		const wrongIdentity = createEvergreenOfferJourneyService({
			ledger,
			authority: {
				currentFacts: () =>
					Effect.succeed(
						facts({ contactId: value(parseContactId('another')) }),
					),
			},
			clock: { now: Effect.succeed(at) },
			definition: EVERGREEN_OFFER_JOURNEY_V1,
		})
		const result = await Effect.runPromise(
			Effect.either(wrongIdentity.advance(stimulus)),
		)
		expect(Either.isLeft(result) && result.left.type).toBe(
			'AuthorityInconsistent',
		)
		expect(ledger.records().stimuli).toHaveLength(0)
	})
	it('stops new due work without rewriting an active journey when control stops', async () => {
		const ledger = makeInMemoryJourneyLedger()
		let stopped = false
		let now = at
		const service = createEvergreenOfferJourneyService({
			ledger,
			authority: {
				currentFacts: ({ journeyId }) =>
					Effect.sync(() =>
						facts({
							existingJourneyId: journeyId,
							...(stopped
								? {
										automationControl: {
											type: 'Stopped' as const,
											version: 'v2',
											reason: 'stop',
										},
									}
								: {}),
						}),
					),
			},
			clock: { now: Effect.sync(() => now) },
			definition: EVERGREEN_OFFER_JOURNEY_V1,
		})
		const start = await Effect.runPromise(service.advance(stimulus))
		if (start.decision.type !== 'Accepted') throw new Error('Expected entry')
		const wake = start.decision.wakeIntents[0]!
		stopped = true
		now = wake.dueAt
		const before = ledger.records()
		const result = await Effect.runPromise(
			service.advance({
				type: 'WakeDue',
				stimulusId: value(parseStimulusId('stopped-wake')),
				journeyId: wake.journeyId,
				wakeId: wake.wakeId,
				dueAt: wake.dueAt,
				purpose: wake.purpose,
			}),
		)
		expect(result).toMatchObject({
			committed: false,
			decision: { type: 'Ignored', reason: 'AutomationHalted' },
		})
		expect(ledger.records()).toEqual(before)
	})

	it('detaches entry input and the pinned definition before asynchronous reads', async () => {
		const ledger = makeInMemoryJourneyLedger()
		const definition = structuredClone(EVERGREEN_OFFER_JOURNEY_V1)
		const service = createEvergreenOfferJourneyService({
			ledger,
			authority: { currentFacts: () => Effect.succeed(facts()) },
			clock: { now: Effect.succeed(at) },
			definition,
		})
		const input = structuredClone(stimulus)
		const pending = service.advance(input)
		Reflect.set(input, 'sourceReference', 'altered')
		Reflect.set(definition, 'messagePlanId', 'altered')
		const result = await Effect.runPromise(pending)
		expect(result.committed).toBe(true)
		expect(ledger.records().stimuli[0]?.stimulus).toEqual(stimulus)
	})
	it('advances independent due slots without waiting for earlier delivery receipts', async () => {
		const ledger = makeInMemoryJourneyLedger()
		let now = at
		const service = createEvergreenOfferJourneyService({
			ledger,
			authority: {
				currentFacts: ({ journeyId }) =>
					Effect.succeed(facts({ existingJourneyId: journeyId })),
			},
			clock: { now: Effect.sync(() => now) },
			definition: EVERGREEN_OFFER_JOURNEY_V1,
		})
		const start = await Effect.runPromise(service.advance(stimulus))
		if (start.decision.type !== 'Accepted') throw new Error('Expected entry')
		for (const [index, wake] of start.decision.wakeIntents
			.slice(0, 2)
			.entries()) {
			now = wake.dueAt
			const result = await Effect.runPromise(
				service.advance({
					type: 'WakeDue',
					stimulusId: value(parseStimulusId(`due-${index}`)),
					journeyId: wake.journeyId,
					wakeId: wake.wakeId,
					dueAt: wake.dueAt,
					purpose: wake.purpose,
				}),
			)
			expect(result).toMatchObject({
				committed: true,
				decision: {
					type: 'Accepted',
					next: { version: index + 2 },
					sideEffectIntents: [{ type: 'SendMessage' }],
				},
			})
		}
		expect(ledger.records().intents).toHaveLength(2)
	})
})
