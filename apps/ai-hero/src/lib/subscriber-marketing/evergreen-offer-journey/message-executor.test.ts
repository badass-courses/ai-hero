import { randomUUID } from 'node:crypto'
import { syntheticRevisionScope } from './revision-delivery.fixtures'
import { Effect, Either } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
	attemptStateAt,
	decodeAttempt,
	type AcceptedOutcome,
	type AttemptEvidence,
	type AttemptOutcome,
} from './attempt-evidence'
import {
	EVERGREEN_OFFER_JOURNEY_V1,
	EVERGREEN_OFFER_JOURNEY_V2,
} from './definition'
import {
	createRevisionDelivery,
	PRODUCTION_DELIVERY_BUNDLES,
} from './revision-delivery'
import type {
	CourseSequenceExhausted,
	EligibilityFacts,
	EvergreenOfferJourneyAggregate,
	EvergreenOfferJourneyDefinition,
	SendMessageIntent,
	SideEffectIntent,
} from './domain'
import { makeInMemoryJourneyLedger } from './in-memory-ledger'
import {
	KIT_ALREADY_MEMBER_REASON,
	createKitDeliveryPort,
} from './kit-delivery'
import {
	createKitMembershipReconciliation,
	createMessageIntentExecutor,
	type DeliveryMembershipEvidence,
	type JourneyAttempts,
	type MessageExecutionResult,
} from './message-executor'
import type {
	DeliveryPort,
	EffectApplicationError,
	EvergreenOfferJourneyService,
	JourneyLedger,
} from './ports'
import {
	parseContactId,
	parseEntryFactId,
	parseIanaTimeZone,
	parseIsoInstant,
	parseStimulusId,
	type IsoInstant,
	type ParseResult,
} from './primitives'
import { restoreEvergreenOfferJourneySnapshot } from './restoration'
import { createEvergreenOfferJourneyService } from './service'

function value<T>(result: ParseResult<T>): T {
	if (!result.ok) throw new Error('Invalid test fixture')
	return result.value
}
const at = value(parseIsoInstant('2026-09-04T17:00:00.000Z'))
const contactId = value(parseContactId('executor-contact'))
const entry: CourseSequenceExhausted = {
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
const purchase = {
	purchaseId: 'purchase',
	offerProductFamily: 'ai-coding-crash-course',
	sourceProductId: 'product-ma254',
	purchasedAt: at,
	sourceReference: 'purchase:verified',
} as const
function baseFacts(): EligibilityFacts {
	return {
		contactId,
		purchase: null,
		delivery: { type: 'Eligible' },
		existingJourneyId: null,
		automationControl: { type: 'Enabled', version: 'control-v1' },
		evidenceVersion: 'facts-v1',
		readAt: at,
	}
}
const plus = (instant: string, ms: number) =>
	value(parseIsoInstant(new Date(Date.parse(instant) + ms).toISOString()))
/** Existing cases only need the page's results; paging itself is covered separately. */
const unpaged = <Item, Error>(
	page: Effect.Effect<{ readonly results: readonly Item[] }, Error>,
) => Effect.map(page, (loaded) => loaded.results)

class Refusal extends Error {}
/** Mirrors the Drizzle attempt boundary rules over the in-memory ledger's intent rows. */
function makeFakeAttempts(
	ledger: ReturnType<typeof makeInMemoryJourneyLedger>,
): JourneyAttempts & { readonly rows: Map<string, AttemptEvidence> } {
	const rows = new Map<string, AttemptEvidence>()
	const run = <Value>(work: () => Value) =>
		Effect.try({
			try: work,
			catch: (cause) => ({
				type:
					cause instanceof Refusal ? 'AttemptRefused' : 'AttemptUnavailable',
				reason: cause instanceof Refusal ? cause.message : 'unavailable',
			}),
		}) as Effect.Effect<
			Value,
			{ type: 'AttemptRefused' | 'AttemptUnavailable'; reason: string }
		>
	const intentRow = (idempotencyKey: string) =>
		ledger
			.records()
			.intents.find((record) => record.idempotencyKey === idempotencyKey)
	const settle = (
		request: {
			idempotencyKey: string
			journeyId: string
			claimToken: string
			now: Date
			outcome: AttemptOutcome
		},
		reconcile: boolean,
	) => {
		const evidence = rows.get(request.idempotencyKey)
		if (!evidence) throw new Refusal('Attempt not found')
		if (
			evidence.journeyId !== request.journeyId ||
			evidence.claimToken !== request.claimToken
		)
			throw new Refusal('Current exact attempt ownership required')
		if (request.now < evidence.claimedAt)
			throw new Refusal('Settlement predates claim')
		if (
			evidence.status === request.outcome.type &&
			JSON.stringify(evidence.outcome) === JSON.stringify(request.outcome)
		)
			return evidence
		// Mirrors the boundary: a new refusal write needs an actual bounded observation.
		if (
			request.outcome.type === 'KnownNotApplied' &&
			(request.outcome.observedAt === undefined ||
				new Date(request.outcome.observedAt) < evidence.claimedAt ||
				new Date(request.outcome.observedAt) > request.now)
		)
			throw new Refusal(
				'Refusal observation is missing or outside claim evidence',
			)
		const state = attemptStateAt(evidence, request.now)
		if (
			reconcile
				? !['Claimed', 'HeldUncertain'].includes(state)
				: state !== 'Claimed'
		)
			throw new Refusal(
				'Attempt is held or already settled; no automatic retry',
			)
		if (
			request.outcome.type === 'Accepted' &&
			(new Date(request.outcome.appliedAt) < evidence.claimedAt ||
				new Date(request.outcome.appliedAt) > request.now)
		)
			throw new Refusal('Acceptance time is outside claim evidence')
		const next = decodeAttempt({
			...evidence,
			status: request.outcome.type,
			outcome: request.outcome,
		})
		rows.set(request.idempotencyKey, next)
		return next
	}
	/** Same page bounds, order and keyset continuation as the Drizzle boundary. */
	function pageLimit(limit: number) {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new Refusal('Recovery page limit must be an integer from 1 to 100')
	}
	const compare = (left: string | number, right: string | number) =>
		left < right ? -1 : left > right ? 1 : 0
	const byLeaseThenKey = (left: AttemptEvidence, right: AttemptEvidence) =>
		compare(left.leaseExpiresAt.getTime(), right.leaseExpiresAt.getTime()) ||
		compare(left.idempotencyKey, right.idempotencyKey)
	const afterLeaseAndKey = (
		row: AttemptEvidence,
		after: { leaseExpiresAt: string; idempotencyKey: string },
	) =>
		compare(row.leaseExpiresAt.getTime(), Date.parse(after.leaseExpiresAt)) ||
		compare(row.idempotencyKey, after.idempotencyKey)
	return {
		rows,
		claim: (input) =>
			run(() => {
				if (
					input.leaseExpiresAt <= input.now ||
					input.leaseExpiresAt.getTime() - input.now.getTime() > 300_000
				)
					throw new Refusal(
						'Claim lease must be positive and at most five minutes',
					)
				const row = intentRow(input.idempotencyKey)
				if (!row || row.journeyId !== input.journeyId)
					throw new Refusal('Exact intent ownership required')
				const previous = rows.get(input.idempotencyKey)
				if (previous)
					return {
						type: 'AlreadyAttempted' as const,
						state: attemptStateAt(previous, input.now),
					}
				const intent = row.intent
				if (intent.type !== 'SendMessage')
					throw new Refusal('Fake attempt boundary supports SendMessage only')
				if (row.status !== 'Pending' || new Date(intent.notBefore) > input.now)
					throw new Refusal('Intent is not pending and due')
				if (
					input.now < new Date(intent.notBefore) ||
					input.now >= new Date(intent.notAfter)
				)
					throw new Refusal('Effect window is closed')
				const evidence = decodeAttempt({
					format: 'evergreen-offer-journey.attempt.v1',
					idempotencyKey: input.idempotencyKey,
					journeyId: input.journeyId,
					claimToken: randomUUID(),
					status: 'Claimed',
					claimedAt: input.now,
					leaseExpiresAt: input.leaseExpiresAt,
					outcome: null,
				})
				rows.set(input.idempotencyKey, evidence)
				return { type: 'Claimed' as const, evidence }
			}),
		settle: (input) => run(() => settle(input, false)),
		reconcileAccepted: (input) => run(() => settle(input, true)),
		recoveryPage,
		recordedOutcomeRecoveryPage,
		recovery: (input) =>
			Effect.map(recoveryPage(input), (page) => page.candidates),
		recordedOutcomeRecovery: (input) =>
			Effect.map(recordedOutcomeRecoveryPage(input), (page) => page.candidates),
	}

	function recoveryPage(input: {
		now: Date
		limit: number
		after?: { leaseExpiresAt: string; idempotencyKey: string }
	}) {
		return run(() => {
			pageLimit(input.limit)
			const after = input.after
			const page = [...rows.values()]
				.filter(
					(row) =>
						(row.status === 'Claimed' && row.leaseExpiresAt <= input.now) ||
						row.status === 'HeldUncertain',
				)
				.filter((row) => !after || afterLeaseAndKey(row, after) > 0)
				.sort(byLeaseThenKey)
				.slice(0, input.limit)
			const candidates = page.map((evidence) => ({
				evidence,
				state: 'HeldUncertain' as const,
			}))
			const last = candidates.at(-1)?.evidence
			return {
				candidates,
				scanned: page.length,
				end: page.length < input.limit,
				nextCursor: last
					? {
							leaseExpiresAt: last.leaseExpiresAt.toISOString(),
							idempotencyKey: last.idempotencyKey,
						}
					: (after ?? null),
			}
		})
	}
	function recordedOutcomeRecoveryPage(input: {
		now: Date
		limit: number
		after?: {
			status: 'Accepted' | 'KnownNotApplied'
			leaseExpiresAt: string
			idempotencyKey: string
		}
	}) {
		return run(() => {
			pageLimit(input.limit)
			const after = input.after
			const page: {
				evidence: AttemptEvidence
				intent: SideEffectIntent
			}[] = []
			const recorded = [...rows.values()]
				.filter((row) => ['Accepted', 'KnownNotApplied'].includes(row.status))
				.filter(
					(row) =>
						!after ||
						compare(row.status, after.status) > 0 ||
						(row.status === after.status && afterLeaseAndKey(row, after) > 0),
				)
				.sort(
					(left, right) =>
						compare(left.status, right.status) || byLeaseThenKey(left, right),
				)
			for (const evidence of recorded) {
				const row = intentRow(evidence.idempotencyKey)
				if (!row) continue
				if (
					row.status === 'Pending' ||
					(row.status === 'Missed' && row.intent.type === 'SendMessage')
				)
					page.push({ evidence, intent: row.intent })
				if (page.length === input.limit) break
			}
			const last = page.at(-1)?.evidence
			return {
				candidates: page,
				scanned: page.length,
				end: page.length < input.limit,
				nextCursor: last
					? {
							status: last.status as 'Accepted' | 'KnownNotApplied',
							leaseExpiresAt: last.leaseExpiresAt.toISOString(),
							idempotencyKey: last.idempotencyKey,
						}
					: (after ?? null),
			}
		})
	}
}

type DeliveryScript = (
	intent: SendMessageIntent,
) => Promise<
	Either.Either<
		{ providerReceiptId: string; appliedAt: IsoInstant },
		EffectApplicationError
	>
>

function harness(
	options: {
		readonly leaseMs?: number
		readonly definition?: EvergreenOfferJourneyDefinition
		readonly entry?: CourseSequenceExhausted
	} = {},
) {
	const ledger = makeInMemoryJourneyLedger()
	let now: IsoInstant = at
	let facts = baseFacts()
	let clockReads = 0
	const clock = {
		now: Effect.sync(() => {
			clockReads++
			return now
		}),
	}
	const authority = {
		currentFacts: ({ journeyId }: { journeyId: string | null }) =>
			Effect.sync(() => ({
				...facts,
				existingJourneyId: journeyId as EligibilityFacts['existingJourneyId'],
				readAt: now,
			})),
	}
	const service = createEvergreenOfferJourneyService({
		ledger,
		authority,
		clock,
		definition: options.definition ?? EVERGREEN_OFFER_JOURNEY_V1,
	})
	const attempts = makeFakeAttempts(ledger)
	const applied: SendMessageIntent[] = []
	let script: DeliveryScript = async () =>
		Either.right({ providerReceiptId: 'fake:accepted', appliedAt: now })
	const delivery: DeliveryPort = {
		apply: (intent) =>
			Effect.gen(function* () {
				applied.push(intent)
				const result = yield* Effect.promise(() => script(intent))
				return yield* result
			}),
	}
	let membership: DeliveryMembershipEvidence = {
		type: 'Absent',
		meaning: 'complete-read-not-resend-permission',
	}
	const inspections: SendMessageIntent[] = []
	const reconciliation = {
		inspect: (intent: SendMessageIntent) =>
			Effect.sync(() => {
				inspections.push(intent)
				return membership
			}),
	}
	const build = (
		overrides: Partial<Parameters<typeof createMessageIntentExecutor>[0]> = {},
	) =>
		createMessageIntentExecutor({
			revisionScope: syntheticRevisionScope(options.definition),
			ledger,
			service,
			authority,
			clock,
			attempts,
			delivery,
			reconciliation,
			leaseMs: options.leaseMs,
			...overrides,
		})
	const executor = build()
	async function start() {
		const started = await Effect.runPromise(
			service.advance(options.entry ?? entry),
		)
		if (started.decision.type !== 'Accepted') throw new Error('Expected entry')
		return started.decision.wakeIntents
	}
	async function wake(index: number) {
		const wakes = await start()
		const wakeIntent = wakes[index]!
		now = wakeIntent.dueAt
		const result = await Effect.runPromise(
			service.advance({
				type: 'WakeDue',
				stimulusId: value(parseStimulusId(`due-${index}`)),
				journeyId: wakeIntent.journeyId,
				wakeId: wakeIntent.wakeId,
				dueAt: wakeIntent.dueAt,
				purpose: wakeIntent.purpose,
			}),
		)
		if (result.decision.type !== 'Accepted') throw new Error('Expected wake')
		const intent = result.decision.sideEffectIntents.find(
			(candidate): candidate is SendMessageIntent =>
				candidate.type === 'SendMessage',
		)
		if (!intent) throw new Error('Expected SendMessage intent')
		return intent
	}
	const target = (intent: SendMessageIntent) => ({
		idempotencyKey: intent.idempotencyKey,
		journeyId: intent.journeyId,
	})
	const execute = (intent: SendMessageIntent, using = executor) =>
		Effect.runPromise(using.execute(target(intent)))
	const intentRecord = (intent: SendMessageIntent) =>
		ledger
			.records()
			.intents.find((record) => record.idempotencyKey === intent.idempotencyKey)
	const aggregate = (): EvergreenOfferJourneyAggregate => {
		const restored = restoreEvergreenOfferJourneySnapshot(
			ledger.records().snapshots.at(-1)!.snapshotJson,
		)
		if (!restored.ok) throw new Error('Snapshot did not restore')
		return restored.value
	}
	const slot = (intent: SendMessageIntent) => {
		const snapshot = aggregate()
		return [...snapshot.messagePlan.bridge, ...snapshot.messagePlan.pitch].find(
			(candidate) => candidate.slotId === intent.slotId,
		)!
	}
	return {
		ledger,
		service,
		authority,
		clock,
		attempts,
		aggregate,
		executor,
		build,
		applied,
		inspections,
		wake,
		execute,
		target,
		intentRecord,
		slot,
		get now() {
			return now
		},
		set now(next: IsoInstant) {
			now = next
		},
		get clockReads() {
			return clockReads
		},
		setFacts: (overrides: Partial<EligibilityFacts>) => {
			facts = { ...baseFacts(), ...overrides }
		},
		setDelivery: (next: DeliveryScript) => {
			script = next
		},
		setMembership: (next: DeliveryMembershipEvidence) => {
			membership = next
		},
	}
}

describe('mandatory original mapping before final apply checks', () => {
	it('missing writer holds before claiming', async () => {
		const h = harness(),
			intent = await h.wake(0)
		const scope = syntheticRevisionScope()
		const result = await h.execute(
			intent,
			h.build({ revisionScope: { ...scope, mappingWriter: null } }),
		)
		expect(result).toEqual({
			type: 'NotClaimed',
			reason: 'MappingUnavailable',
			sideEffects: 'none',
		})
		expect(h.applied).toHaveLength(0)
		expect(h.attempts.rows.size).toBe(0)
	})
	it.each(['lease', 'window', 'control', 'scope'] as const)(
		'rechecks %s after mapping I/O with truthful disclosure',
		async (boundary) => {
			const h = harness(),
				intent = await h.wake(0),
				scope = syntheticRevisionScope()
			let scopeChanged = false
			const writer = {
				record: (
					input: Parameters<
						NonNullable<typeof scope.mappingWriter>['record']
					>[0],
				) =>
					Effect.gen(function* () {
						const receipt = yield* scope.originalMapping!.read(input.attempt)
						if (boundary === 'lease')
							h.now = value(
								parseIsoInstant(
									new Date(Date.parse(h.now) + 300001).toISOString(),
								),
							)
						if (boundary === 'window') h.now = intent.notAfter
						if (boundary === 'control')
							h.setFacts({
								automationControl: {
									type: 'Stopped',
									version: 'mapping-stop',
									reason: 'operator',
								},
							})
						if (boundary === 'scope') scopeChanged = true
						return { type: 'Verified' as const, receipt }
					}),
			}
			const result = await Effect.runPromise(
				Effect.either(
					h
						.build({
							revisionScope: { ...scope, mappingWriter: writer },
							ledger: {
								...h.ledger,
								inspect: (input) =>
									h.ledger.inspect(input).pipe(
										Effect.map((view) =>
											scopeChanged && view.aggregate
												? {
														...view,
														aggregate: {
															...view.aggregate,
															definition: {
																...view.aggregate.definition,
																contentRevision: 'changed',
															},
														},
													}
												: view,
										),
									),
							},
						})
						.execute(h.target(intent)),
				),
			)
			expect(h.applied).toHaveLength(0)
			if (Either.isRight(result))
				expect(result.right).toMatchObject({
					type: 'Abandoned',
					sideEffects: 'mapping-persisted',
				})
			else expect(result.left.sideEffects).toBe('mapping-persisted')
		},
	)
	it('unverifiable persistence holds without KnownNotApplied', async () => {
		const h = harness(),
			intent = await h.wake(0),
			scope = syntheticRevisionScope()
		const result = await h.execute(
			intent,
			h.build({
				revisionScope: {
					...scope,
					mappingWriter: {
						record: () =>
							Effect.succeed({
								type: 'Held',
								reason: 'MappingUnavailable',
								detail: 'readback lost',
								sideEffects: 'mapping-may-have-persisted',
							}),
					},
				},
			}),
		)
		expect(result).toMatchObject({
			type: 'Abandoned',
			reason: 'MappingUnavailable',
			sideEffects: 'mapping-may-have-persisted',
		})
		expect(h.applied).toHaveLength(0)
	})
})

describe('revision delivery guards and dormant composition', () => {
	const definitions = [EVERGREEN_OFFER_JOURNEY_V1, EVERGREEN_OFFER_JOURNEY_V2]
	function bundle(definition: EvergreenOfferJourneyDefinition) {
		const scope = syntheticRevisionScope(definition)
		return {
			...scope,
			providerReadbacks: scope.manifest.messages.map((m) => ({
				sequenceId: m.sequenceId,
				repeat: false as const,
				emailCount: 1 as const,
				published: true as const,
				active: true as const,
				hold: false as const,
			})),
		}
	}
	function composed(
		h: ReturnType<typeof harness>,
		bundles = definitions.map(bundle),
		responseStatus = 201,
		getAddedAt: string = h.now,
	) {
		const requests: string[] = []
		const syntheticBodies: string[] = []
		const front = createRevisionDelivery({
			bundles,
			dependencies: {
				ledger: h.ledger,
				service: h.service,
				authority: h.authority,
				clock: h.clock,
				attempts: h.attempts,
			},
			now: () => h.now,
			kit: {
				apiKey: 'synthetic-no-network',
				resolveIdentity: async (contactId) => ({ contactId, subscriberId: 91 }),
				fetch: (async (url, options) => {
					requests.push(String(url))
					if (options?.method === 'GET')
						return new Response(
							JSON.stringify({
								subscribers: [
									{ id: 91, state: 'active', added_at: getAddedAt },
								],
								pagination: { has_next_page: false, end_cursor: '' },
							}),
							{ status: 200 },
						)
					if (responseStatus === 201 && String(url).includes('/1002/'))
						syntheticBodies.push('SYNTHETIC Thursday B3')
					if (responseStatus === 201 && String(url).includes('/2002/'))
						syntheticBodies.push('SYNTHETIC Friday B3')
					return new Response(
						JSON.stringify({ subscriber: { id: 91, state: 'active' } }),
						{ status: responseStatus },
					)
				}) as typeof fetch,
			},
		})
		return { front, requests, syntheticBodies }
	}
	it.each(definitions)(
		'blocks the other revision at the low-level executor: $definitionVersion',
		async (definition) => {
			const h = harness({ definition })
			const intent = await h.wake(2)
			const other = definitions.find(
				(d) => d.definitionVersion !== definition.definitionVersion,
			)!
			expect(
				await h.execute(
					intent,
					h.build({ revisionScope: syntheticRevisionScope(other) }),
				),
			).toMatchObject({ type: 'NotClaimed', reason: 'RevisionMismatch' })
			expect(h.attempts.rows.size).toBe(0)
			expect(h.applied).toHaveLength(0)
		},
	)
	it.each([
		'definitionVersion',
		'messagePlanId',
		'contentRevision',
		'messagePlanSourceHash',
		'presentationReviewRevision',
	] as const)('compares the full tuple: %s', async (field) => {
		const h = harness()
		const intent = await h.wake(0)
		const scope = syntheticRevisionScope()
		scope.manifest.revision[field] =
			field === 'messagePlanSourceHash' ? 'f'.repeat(64) : 'wrong'
		expect(
			await h.execute(intent, h.build({ revisionScope: scope })),
		).toMatchObject({ type: 'NotClaimed', reason: 'RevisionMismatch' })
		expect(h.attempts.rows.size).toBe(0)
		expect(h.applied).toHaveLength(0)
	})
	it('runtime absence cannot bypass the required scope', async () => {
		const h = harness()
		const intent = await h.wake(0)
		expect(
			await h.execute(intent, h.build({ revisionScope: undefined as never })),
		).toMatchObject({ type: 'NotClaimed', reason: 'RevisionUnavailable' })
		expect(h.attempts.rows.size).toBe(0)
	})
	it.each([false, true])(
		'rechecks canonical revision after claim and before no-request retry: %s',
		async (retry) => {
			const h = harness()
			const intent = await h.wake(0)
			let reads = 0
			const ledger: JourneyLedger = {
				...h.ledger,
				inspect: (query) =>
					h.ledger.inspect(query).pipe(
						Effect.map((view) => {
							reads++
							if (reads >= (retry ? 3 : 2))
								return {
									...view,
									aggregate: {
										...view.aggregate,
										definition: {
											...view.aggregate.definition,
											contentRevision: 'changed',
										},
									},
								}
							return view
						}),
					),
			}
			h.setDelivery(async () =>
				Either.left({
					type: 'EffectTransientUnavailable',
					reason: 'before-request',
					requestIssued: false,
				}),
			)
			expect(await h.execute(intent, h.build({ ledger }))).toMatchObject({
				type: 'Abandoned',
				reason: 'RevisionChangedAfterClaim',
				applyInvocations: retry ? 1 : 0,
			})
			expect(h.applied).toHaveLength(retry ? 1 : 0)
			expect(h.attempts.rows.get(intent.idempotencyKey)?.outcome).toBeNull()
			expect(h.intentRecord(intent)?.status).toBe('Pending')
		},
	)
	it('frontdoor load cannot overrule contradictory canonical inspection', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const ledger: JourneyLedger = {
			...h.ledger,
			inspect: (query) =>
				h.ledger.inspect(query).pipe(
					Effect.map((view) => ({
						...view,
						aggregate: {
							...view.aggregate,
							messagePlan: {
								...view.aggregate.messagePlan,
								contentRevision: 'contradictory-plan',
							},
						},
					})),
				),
		}
		const { front, requests } = composed({
			...h,
			ledger: { ...h.ledger, ...ledger },
		})
		expect(
			await Effect.runPromise(front.execute(h.target(intent))),
		).toMatchObject({ type: 'NotClaimed', reason: 'RevisionMismatch' })
		expect(requests).toHaveLength(0)
		expect(h.attempts.rows.size).toBe(0)
	})
	it('does not apply an unmapped V2 using the registered V1 shared resource IDs', async () => {
		const h = harness({ definition: EVERGREEN_OFFER_JOURNEY_V2 })
		const intent = await h.wake(2)
		const { front, requests } = composed(h, [
			bundle(EVERGREEN_OFFER_JOURNEY_V1),
		])
		expect(
			await Effect.runPromise(front.execute(h.target(intent))),
		).toMatchObject({ type: 'NotClaimed', reason: 'RevisionUnavailable' })
		expect(requests).toHaveLength(0)
		expect(h.attempts.rows.size).toBe(0)
	})
	it('holds canonical change during GET without recording membership acceptance', async () => {
		const h = harness()
		const intent = await h.wake(0)
		h.setDelivery(async () =>
			Either.left({ type: 'EffectAmbiguous', reason: 'lost-response' }),
		)
		await h.execute(intent)
		const addedAt = h.now
		h.now = plus(h.now, 61_000)
		const before = structuredClone(h.attempts.rows.get(intent.idempotencyKey))
		let inspected = false
		let gets = 0
		const ledger: JourneyLedger = {
			...h.ledger,
			inspect: (query) =>
				h.ledger.inspect(query).pipe(
					Effect.map((view) =>
						inspected
							? {
									...view,
									aggregate: {
										...view.aggregate,
										definition: {
											...view.aggregate.definition,
											contentRevision: 'changed-during-get',
										},
									},
								}
							: view,
					),
				),
		}
		const reconciliation = {
			inspect: () =>
				Effect.sync(() => {
					gets++
					inspected = true
					return {
						type: 'Present' as const,
						providerReceiptId: 'synthetic-get',
						addedAt,
						observedAt: h.now,
					}
				}),
		}
		const page = await Effect.runPromise(
			h.build({ ledger, reconciliation }).reconcileHeld({ limit: 1 }),
		)
		expect(gets).toBe(1)
		expect(page.results[0]?.result).toMatchObject({
			type: 'UnknownHeld',
			reason: 'RevisionMismatch',
		})
		expect(h.attempts.rows.get(intent.idempotencyKey)).toEqual(before)
		expect(h.intentRecord(intent)?.status).toBe('Pending')
	})
	it('does not mistake a newer actor version for a new revision', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const ledger: JourneyLedger = {
			...h.ledger,
			inspect: (query) =>
				h.ledger.inspect(query).pipe(
					Effect.map((view) => ({
						...view,
						aggregate: {
							...view.aggregate,
							version: view.aggregate.version + 1,
						},
					})),
				),
		}
		expect(await h.execute(intent, h.build({ ledger }))).toMatchObject({
			type: 'Applied',
		})
		expect(h.applied).toHaveLength(1)
	})
	it.each(['wrong-revision', 'missing-original'] as const)(
		'holds uncertain recovery without GET or writes: %s',
		async (reason) => {
			const h = harness()
			const intent = await h.wake(0)
			h.setDelivery(async () =>
				Either.left({ type: 'EffectAmbiguous', reason: 'lost-response' }),
			)
			await h.execute(intent)
			h.now = value(
				parseIsoInstant(new Date(Date.parse(h.now) + 61_000).toISOString()),
			)
			const before = structuredClone(h.attempts.rows.get(intent.idempotencyKey))
			const scope = syntheticRevisionScope(
				reason === 'wrong-revision'
					? EVERGREEN_OFFER_JOURNEY_V2
					: EVERGREEN_OFFER_JOURNEY_V1,
			)
			const executor = h.build({
				revisionScope:
					reason === 'missing-original'
						? { ...scope, originalMapping: null }
						: scope,
			})
			const page = await Effect.runPromise(executor.reconcileHeld({ limit: 1 }))
			expect(page.results[0]?.result).toMatchObject({
				type: 'UnknownHeld',
				reason:
					reason === 'wrong-revision'
						? 'RevisionMismatch'
						: 'OriginalMappingUnavailable',
			})
			expect(page.scanned).toBe(1)
			expect(page.nextCursor).not.toBeNull()
			expect(h.inspections).toHaveLength(0)
			expect(h.attempts.rows.get(intent.idempotencyKey)).toEqual(before)
		},
	)
	it.each(['wrong-revision', 'missing-original'] as const)(
		'holds recorded recovery without settlement: %s',
		async (reason) => {
			const h = harness()
			const intent = await h.wake(0)
			const claim = await Effect.runPromise(
				h.attempts.claim({
					idempotencyKey: intent.idempotencyKey,
					journeyId: intent.journeyId,
					now: new Date(h.now),
					leaseExpiresAt: new Date(Date.parse(h.now) + 60_000),
				}),
			)
			if (claim.type !== 'Claimed') throw new Error('Expected fresh claim')
			await Effect.runPromise(
				h.attempts.settle({
					idempotencyKey: intent.idempotencyKey,
					journeyId: intent.journeyId,
					claimToken: claim.evidence.claimToken,
					now: new Date(h.now),
					outcome: {
						type: 'Accepted',
						providerReceiptId: 'synthetic-original',
						appliedAt: h.now,
					},
				}),
			)
			expect(h.attempts.rows.get(intent.idempotencyKey)?.status).toBe(
				'Accepted',
			)
			const before = structuredClone(h.attempts.rows.get(intent.idempotencyKey))
			const scope = syntheticRevisionScope(
				reason === 'wrong-revision'
					? EVERGREEN_OFFER_JOURNEY_V2
					: EVERGREEN_OFFER_JOURNEY_V1,
			)
			const page = await Effect.runPromise(
				h
					.build({
						revisionScope:
							reason === 'missing-original'
								? { ...scope, originalMapping: null }
								: scope,
					})
					.settleRecordedOutcomes({ limit: 1 }),
			)
			expect(page.results[0]?.settlement).toMatchObject({
				type: 'RevisionHeld',
			})
			expect(page.scanned).toBe(1)
			expect(page.nextCursor).not.toBeNull()
			expect(h.intentRecord(intent)?.status).toBe('Pending')
			expect(h.attempts.rows.get(intent.idempotencyKey)).toEqual(before)
		},
	)
	it.each(definitions)(
		'selects B3 synthetic body/sequence by canonical revision: $definitionVersion',
		async (definition) => {
			const h = harness({ definition })
			const intent = await h.wake(2)
			const { front, requests, syntheticBodies } = composed(h)
			const preview = await Effect.runPromise(front.preview(h.target(intent)))
			expect(preview.type).toBe('Selected')
			if (preview.type !== 'Selected')
				throw new Error('Expected scoped manifest')
			expect(preview.manifest.messages[2]?.bodySha256).toBe(
				syntheticRevisionScope(definition).manifest.messages[2]?.bodySha256,
			)
			expect(
				await Effect.runPromise(front.execute(h.target(intent))),
			).toMatchObject({ type: 'Applied' })
			expect(requests).toEqual([
				`https://api.kit.com/v4/sequences/${definition.definitionVersion === 'evergreen-offer-v2' ? 2002 : 1002}/subscribers/91`,
			])
			expect(syntheticBodies).toEqual([
				definition.definitionVersion === 'evergreen-offer-v2'
					? 'SYNTHETIC Friday B3'
					: 'SYNTHETIC Thursday B3',
			])
		},
	)
	it('freezes caller mapping and refuses duplicate/empty registration', async () => {
		const h = harness()
		const intent = await h.wake(2)
		const bundles = definitions.map(bundle)
		const { front, requests } = composed(h, bundles)
		bundles[0]!.manifest.messages[2]!.sequenceId = 9999
		bundles[0]!.manifest.messages[2]!.bodySha256 = 'f'.repeat(64)
		expect(
			await Effect.runPromise(front.execute(h.target(intent))),
		).toMatchObject({ type: 'Applied' })
		expect(requests[0]).toContain('/1002/')
		for (const candidates of [
			[],
			[bundle(EVERGREEN_OFFER_JOURNEY_V1), bundle(EVERGREEN_OFFER_JOURNEY_V1)],
		]) {
			const held = composed(h, candidates)
			expect(
				await Effect.runPromise(held.front.execute(h.target(intent))),
			).toMatchObject({ type: 'NotClaimed', reason: 'RevisionUnavailable' })
			expect(held.requests).toHaveLength(0)
		}
		expect(PRODUCTION_DELIVERY_BUNDLES).toHaveLength(0)
	})
	it.each([false, true])(
		'advances global cursors past interleaved foreign rows without touching them, recorded=%s',
		async (recorded) => {
			const h = harness()
			const foreign = harness({
				definition: EVERGREEN_OFFER_JOURNEY_V2,
				entry: {
					...entry,
					stimulusId: value(parseStimulusId('aaa-entry')),
					entryFactId: value(parseEntryFactId('aaa-entry')),
				},
			})
			const intent = await h.wake(0)
			const other = await foreign.wake(0)
			const ledger = {
				...h.ledger,
				load: (id: typeof intent.journeyId) =>
					(id === other.journeyId ? foreign.ledger : h.ledger).load(id),
				inspect: (query: Parameters<JourneyLedger['inspect']>[0]) =>
					(query.journeyId === other.journeyId
						? foreign.ledger
						: h.ledger
					).inspect(query),
				records: () => {
					const a = h.ledger.records()
					const b = foreign.ledger.records()
					return {
						snapshots: [...a.snapshots, ...b.snapshots],
						events: [...a.events, ...b.events],
						intents: [...a.intents, ...b.intents],
						wakes: [...a.wakes, ...b.wakes],
						stimuli: [...a.stimuli, ...b.stimuli],
						receipts: [...a.receipts, ...b.receipts],
					}
				},
			}
			const attempts = makeFakeAttempts(ledger)
			for (const item of [intent, other]) {
				const claim = await Effect.runPromise(
					attempts.claim({
						idempotencyKey: item.idempotencyKey,
						journeyId: item.journeyId,
						now: new Date(h.now),
						leaseExpiresAt: new Date(Date.parse(h.now) + 60_000),
					}),
				)
				if (claim.type !== 'Claimed') throw new Error('Expected fresh claim')
				if (recorded)
					await Effect.runPromise(
						attempts.settle({
							idempotencyKey: item.idempotencyKey,
							journeyId: item.journeyId,
							claimToken: claim.evidence.claimToken,
							now: new Date(h.now),
							outcome: {
								type: 'Accepted',
								providerReceiptId: 'synthetic-original',
								appliedAt: h.now,
							},
						}),
					)
			}
			h.now = plus(h.now, 61_000)
			const before = structuredClone(attempts.rows.get(other.idempotencyKey))
			const executor = h.build({ ledger, attempts })
			if (recorded) {
				const first = await Effect.runPromise(
					executor.settleRecordedOutcomes({ limit: 1 }),
				)
				expect(first.results[0]?.journeyId).toBe(other.journeyId)
				expect(first.results[0]?.settlement.type).toBe('RevisionHeld')
				const second = await Effect.runPromise(
					executor.settleRecordedOutcomes({
						limit: 1,
						after: first.nextCursor!,
					}),
				)
				expect(second.results[0]?.journeyId).toBe(intent.journeyId)
				expect(second.results[0]?.settlement.type).toBe('Committed')
				expect(second.end).toBe(false)
				const done = await Effect.runPromise(
					executor.settleRecordedOutcomes({
						limit: 1,
						after: second.nextCursor!,
					}),
				)
				expect(done).toMatchObject({ scanned: 0, end: true })
			} else {
				const first = await Effect.runPromise(
					executor.reconcileHeld({ limit: 1 }),
				)
				expect(first.results[0]?.journeyId).toBe(other.journeyId)
				expect(first.results[0]?.result).toMatchObject({
					type: 'UnknownHeld',
					reason: 'RevisionMismatch',
				})
				const second = await Effect.runPromise(
					executor.reconcileHeld({ limit: 1, after: first.nextCursor! }),
				)
				expect(second.results[0]?.journeyId).toBe(intent.journeyId)
				expect(second.results[0]?.result.type).toBe('AbsentHeld')
				expect(second.end).toBe(false)
				const done = await Effect.runPromise(
					executor.reconcileHeld({ limit: 1, after: second.nextCursor! }),
				)
				expect(done).toMatchObject({ scanned: 0, end: true })
				expect(h.inspections).toHaveLength(1)
			}
			expect(attempts.rows.get(other.idempotencyKey)).toEqual(before)
			expect(foreign.intentRecord(other)?.status).toBe('Pending')
		},
	)
	it('restarts into matching original bundle and GETs only its pinned sequence', async () => {
		const h = harness()
		const intent = await h.wake(2)
		const originalAt = h.now
		const first = composed(h, definitions.map(bundle), 200)
		expect(
			await Effect.runPromise(first.front.execute(h.target(intent))),
		).toMatchObject({ type: 'HeldUncertain' })
		h.now = plus(h.now, 61_000)
		const restarted = composed(h, definitions.map(bundle), 200, originalAt)
		const result = await Effect.runPromise(
			restarted.front.reconcileHeld({ limit: 10 }),
		)
		expect(result.type).toBe('Pages')
		expect(restarted.requests).toHaveLength(1)
		expect(restarted.requests[0]).toContain('/1002/subscribers?')
		expect(h.attempts.rows.get(intent.idempotencyKey)?.outcome).toMatchObject({
			type: 'Accepted',
			appliedAt: originalAt,
		})
		expect(h.intentRecord(intent)?.status).toBe('Applied')
		expect(first.requests).toHaveLength(1)
	})
	it('selects reordered raw revisions and rejects reordered duplicates', async () => {
		const h = harness()
		const intent = await h.wake(2)
		const reordered = bundle(EVERGREEN_OFFER_JOURNEY_V1)
		const r = reordered.manifest.revision
		reordered.manifest.revision = {
			presentationReviewRevision: r.presentationReviewRevision,
			messagePlanSourceHash: r.messagePlanSourceHash,
			contentRevision: r.contentRevision,
			messagePlanId: r.messagePlanId,
			definitionVersion: r.definitionVersion,
		}
		const good = composed(h, [reordered])
		expect(good.front.registry().type).toBe('Configured')
		expect(
			await Effect.runPromise(good.front.execute(h.target(intent))),
		).toMatchObject({ type: 'Applied' })
		expect(good.requests[0]).toContain('/1002/')
		const duplicate = composed(h, [
			bundle(EVERGREEN_OFFER_JOURNEY_V1),
			reordered,
		])
		expect(duplicate.front.registry()).toEqual({
			type: 'Invalid',
			reason: 'DuplicateRevision',
			registeredRevisions: [],
		})
		expect(
			await Effect.runPromise(duplicate.front.execute(h.target(intent))),
		).toMatchObject({ type: 'NotClaimed', reason: 'RevisionUnavailable' })
		expect(duplicate.requests).toHaveLength(0)
	})
	it('reports bounded immutable registry diagnostics without partial configuration', async () => {
		const h = harness()
		const intent = await h.wake(2)
		const invalid = bundle(EVERGREEN_OFFER_JOURNEY_V1)
		invalid.manifest.messages[0]!.bodySha256 = 'private-invalid-input'
		for (const [bundles, expected] of [
			[[], { type: 'Unconfigured', registeredRevisions: [] }],
			[
				[bundle(EVERGREEN_OFFER_JOURNEY_V2), invalid],
				{ type: 'Invalid', reason: 'InvalidBundle', registeredRevisions: [] },
			],
			[
				[...definitions.map(bundle), bundle(EVERGREEN_OFFER_JOURNEY_V1)],
				{ type: 'Invalid', reason: 'TooManyBundles', registeredRevisions: [] },
			],
		] as const) {
			const held = composed(h, [...bundles])
			expect(held.front.registry()).toEqual(expected)
			expect(Object.isFrozen(held.front.registry())).toBe(true)
			expect(
				await Effect.runPromise(held.front.execute(h.target(intent))),
			).toMatchObject({ type: 'NotClaimed', reason: 'RevisionUnavailable' })
			expect(held.requests).toHaveLength(0)
		}
		const inputs = definitions.map(bundle)
		const good = composed(h, inputs)
		const status = good.front.registry()
		expect(status.type).toBe('Configured')
		expect(status.registeredRevisions).toHaveLength(2)
		expect(Object.isFrozen(status.registeredRevisions)).toBe(true)
		expect(
			Reflect.set(status.registeredRevisions[0]!, 'contentRevision', 'wrong'),
		).toBe(false)
		expect(Reflect.set(status, 'type', 'Invalid')).toBe(false)
		inputs[0]!.manifest.revision.contentRevision = 'wrong'
		inputs[0]!.manifest.messages[2]!.sequenceId = 9999
		expect(good.front.registry()).toBe(status)
		expect(status.registeredRevisions[0]?.contentRevision).toBe(
			EVERGREEN_OFFER_JOURNEY_V1.contentRevision,
		)
		expect(
			await Effect.runPromise(good.front.execute(h.target(intent))),
		).toMatchObject({ type: 'Applied' })
		expect(good.requests[0]).toContain('/1002/')
	})
	it('preserves already-member uncertainty through composition', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const { front, requests } = composed(h, definitions.map(bundle), 200)
		expect(
			await Effect.runPromise(front.execute(h.target(intent))),
		).toMatchObject({ type: 'HeldUncertain' })
		expect(requests).toHaveLength(1)
		expect(h.intentRecord(intent)?.status).toBe('Pending')
	})
})

describe('SendMessage intent executor', () => {
	it('claims, applies once and settles the persisted B1 intent truthfully', async () => {
		const h = harness()
		const intent = await h.wake(0)
		expect(h.intentRecord(intent)?.status).toBe('Pending')
		const result = await h.execute(intent)
		expect(result).toMatchObject({
			type: 'Applied',
			meaning: 'provider-accepted-not-inbox-delivery',
			providerReceiptId: 'fake:accepted',
			sideEffects: 'attempt-recorded',
			settlement: {
				type: 'Committed',
				stimulusId: expect.stringContaining(
					`${intent.idempotencyKey}:attempt:`,
				),
			},
		})
		expect(h.applied).toHaveLength(1)
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'Accepted',
			outcome: { type: 'Accepted', providerReceiptId: 'fake:accepted' },
		})
		expect(h.intentRecord(intent)?.status).toBe('Applied')
		expect(h.slot(intent)).toMatchObject({
			status: 'Applied',
			providerReceiptId: 'fake:accepted',
		})
		const again = await h.execute(intent)
		expect(again).toEqual({
			type: 'NotClaimed',
			reason: 'IntentNotPending',
			sideEffects: 'none',
		})
		expect(h.applied).toHaveLength(1)
	})

	it('lets exactly one of two concurrent executors apply', async () => {
		const h = harness()
		const intent = await h.wake(0)
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		h.setDelivery(async () => {
			await gate
			return Either.right({
				providerReceiptId: 'fake:accepted',
				appliedAt: h.now,
			})
		})
		const second = h.build()
		const racing = Promise.all([
			h.execute(intent),
			new Promise<MessageExecutionResult>((resolve) => {
				setTimeout(() => void h.execute(intent, second).then(resolve), 5)
			}),
		])
		setTimeout(release, 20)
		const [winner, loser] = await racing
		expect(winner.type).toBe('Applied')
		expect(loser).toEqual({
			type: 'AlreadyAttempted',
			state: 'Claimed',
			sideEffects: 'none',
		})
		expect(h.applied).toHaveLength(1)
		expect(h.attempts.rows.get(intent.idempotencyKey)?.status).toBe('Accepted')
	})

	it('never resends after a crash between claim and provider call, even after the lease', async () => {
		const h = harness({ leaseMs: 1_000 })
		const intent = await h.wake(0)
		const claimed = await Effect.runPromise(
			h.attempts.claim({
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				now: new Date(h.now),
				leaseExpiresAt: new Date(Date.parse(h.now) + 1_000),
			}),
		)
		expect(claimed.type).toBe('Claimed')
		expect(await h.execute(intent)).toEqual({
			type: 'AlreadyAttempted',
			state: 'Claimed',
			sideEffects: 'none',
		})
		h.now = plus(h.now, 1_000)
		expect(await h.execute(intent)).toEqual({
			type: 'AlreadyAttempted',
			state: 'HeldUncertain',
			sideEffects: 'none',
		})
		expect(h.applied).toHaveLength(0)
		const absent = await Effect.runPromise(
			unpaged(h.executor.reconcileHeld({ limit: 10 })),
		)
		expect(absent).toEqual([
			{
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				result: { type: 'AbsentHeld', meaning: 'not-resend-permission' },
				sideEffects: 'none',
			},
		])
		h.setMembership({ type: 'Unknown', reason: 'membership-page-cap' })
		const unknown = await Effect.runPromise(
			unpaged(h.executor.reconcileHeld({ limit: 10 })),
		)
		expect(unknown[0]?.result).toEqual({
			type: 'UnknownHeld',
			reason: 'membership-page-cap',
		})
		expect(h.inspections).toHaveLength(2)
		expect(h.applied).toHaveLength(0)
		expect(h.attempts.rows.get(intent.idempotencyKey)?.status).toBe('Claimed')
		expect(h.intentRecord(intent)?.status).toBe('Pending')
	})

	it('recovers a crash after provider acceptance through GET-only positive membership', async () => {
		const h = harness({ leaseMs: 1_000 })
		const intent = await h.wake(0)
		const claimAt = h.now
		const claimed = await Effect.runPromise(
			h.attempts.claim({
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				now: new Date(h.now),
				leaseExpiresAt: new Date(Date.parse(h.now) + 1_000),
			}),
		)
		if (claimed.type !== 'Claimed') throw new Error('Expected claim')
		// Provider accepted, then the process died before settling the attempt.
		const addedAt = plus(claimAt, 1_500)
		h.now = plus(h.now, 2_000)
		h.setMembership({
			type: 'Present',
			providerReceiptId: 'kit:sequence-membership-observed:b1',
			addedAt,
			observedAt: h.now,
		})
		const recovered = await Effect.runPromise(
			unpaged(h.executor.reconcileHeld({ limit: 10 })),
		)
		expect(recovered).toEqual([
			{
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				result: {
					type: 'ReconciledAccepted',
					providerReceiptId: 'kit:sequence-membership-observed:b1',
					addedAt,
					observedAt: h.now,
					settlement: { type: 'Committed', stimulusId: expect.any(String) },
				},
				sideEffects: 'attempt-recorded',
			},
		])
		expect(h.applied).toHaveLength(0)
		// The provider's instant is the acceptance time, not the observation time.
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'Accepted',
			claimToken: claimed.evidence.claimToken,
			outcome: { appliedAt: addedAt },
		})
		expect(h.intentRecord(intent)?.status).toBe('Applied')
		expect(h.ledger.records().stimuli.at(-1)?.stimulus).toMatchObject({
			type: 'DeliverySettled',
			settledAt: addedAt,
		})
		expect(
			await Effect.runPromise(unpaged(h.executor.reconcileHeld({ limit: 10 }))),
		).toEqual([])
	})

	it.each([
		[
			'missing',
			() => null,
			{ type: 'UnknownHeld', reason: 'membership-added-at-unknown' },
		],
		[
			'before this claim',
			(claimAt: IsoInstant) => plus(claimAt, -1),
			{ type: 'MembershipHeld', reason: 'PrecedesClaim' },
		],
		[
			'at or after the window end',
			(_claimAt: IsoInstant, intent: SendMessageIntent) => intent.notAfter,
			{ type: 'MembershipHeld', reason: 'AfterWindow' },
		],
		[
			'in the future',
			(claimAt: IsoInstant) => plus(claimAt, 2_001),
			{ type: 'MembershipHeld', reason: 'InFuture' },
		],
	] as const)(
		'holds membership whose provider instant is %s without writing anything',
		async (_label, addedAtFor, expected) => {
			const h = harness({ leaseMs: 1_000 })
			const intent = await h.wake(0)
			const claimAt = h.now
			await Effect.runPromise(
				h.attempts.claim({
					idempotencyKey: intent.idempotencyKey,
					journeyId: intent.journeyId,
					now: new Date(h.now),
					leaseExpiresAt: new Date(Date.parse(h.now) + 1_000),
				}),
			)
			h.now = plus(claimAt, 2_000)
			const addedAt = addedAtFor(claimAt, intent)
			const stimuliBefore = h.ledger.records().stimuli.length
			h.setMembership({
				type: 'Present',
				providerReceiptId: 'kit:sequence-membership-observed:b1',
				addedAt,
				observedAt: h.now,
			})
			const held = await Effect.runPromise(
				unpaged(h.executor.reconcileHeld({ limit: 10 })),
			)
			expect(held[0]).toMatchObject({
				result: addedAt
					? { ...expected, addedAt, observedAt: h.now }
					: expected,
				sideEffects: 'none',
			})
			expect(h.attempts.rows.get(intent.idempotencyKey)?.status).toBe('Claimed')
			expect(h.intentRecord(intent)?.status).toBe('Pending')
			expect(h.ledger.records().stimuli).toHaveLength(stimuliBefore)
			expect(h.applied).toHaveLength(0)
		},
	)

	it('accepts membership added exactly at the claim instant as the acceptance time', async () => {
		const h = harness({ leaseMs: 1_000 })
		const intent = await h.wake(0)
		const claimAt = h.now
		await Effect.runPromise(
			h.attempts.claim({
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				now: new Date(h.now),
				leaseExpiresAt: new Date(Date.parse(h.now) + 1_000),
			}),
		)
		h.now = plus(claimAt, 3_000)
		h.setMembership({
			type: 'Present',
			providerReceiptId: 'kit:sequence-membership-observed:b1',
			addedAt: claimAt,
			observedAt: h.now,
		})
		const result = await Effect.runPromise(
			unpaged(h.executor.reconcileHeld({ limit: 10 })),
		)
		expect(result[0]?.result).toMatchObject({
			type: 'ReconciledAccepted',
			addedAt: claimAt,
		})
		expect(h.attempts.rows.get(intent.idempotencyKey)?.outcome).toMatchObject({
			appliedAt: claimAt,
		})
	})

	it('commits the same historical receipt once after a crash between attempt and domain', async () => {
		const h = harness()
		const intent = await h.wake(0)
		let failures = 0
		const crashing: Pick<EvergreenOfferJourneyService, 'advance'> = {
			advance: (stimulus) =>
				Effect.suspend(() => {
					failures++
					return Effect.fail({
						type: 'JourneyCommitUnavailable' as const,
						reason: 'process died',
					})
				}),
		}
		const result = await h.execute(intent, h.build({ service: crashing }))
		expect(result).toMatchObject({
			type: 'Applied',
			settlement: { type: 'Failed', error: 'JourneyCommitUnavailable' },
		})
		expect(failures).toBe(1)
		expect(h.attempts.rows.get(intent.idempotencyKey)?.status).toBe('Accepted')
		expect(h.intentRecord(intent)?.status).toBe('Pending')
		expect(await h.execute(intent)).toMatchObject({
			type: 'AlreadyAttempted',
			state: 'Accepted',
		})
		h.now = plus(h.now, 60_000)
		const settled = await Effect.runPromise(
			unpaged(h.executor.settleRecordedOutcomes({ limit: 10 })),
		)
		const attempt = h.attempts.rows.get(intent.idempotencyKey)!
		expect(settled).toEqual([
			{
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				attemptStatus: 'Accepted',
				settlement: {
					type: 'Committed',
					stimulusId: `${intent.idempotencyKey}:attempt:${attempt.claimToken}:delivery-settled`,
				},
			},
		])
		const stimulus = h.ledger
			.records()
			.stimuli.find((record) => record.stimulusId.includes(':attempt:'))
		expect(stimulus?.stimulus).toMatchObject({
			type: 'DeliverySettled',
			settledAt: (attempt.outcome as AcceptedOutcome).appliedAt,
			outcome: { type: 'Applied', providerReceiptId: 'fake:accepted' },
		})
		expect(h.intentRecord(intent)?.status).toBe('Applied')
		expect(h.slot(intent).status).toBe('Applied')
		expect(
			await Effect.runPromise(
				unpaged(h.executor.settleRecordedOutcomes({ limit: 10 })),
			),
		).toEqual([])
		expect(h.applied).toHaveLength(1)
	})

	it.each([
		['purchase', { purchase }, 'PurchaseObserved'],
		[
			'unsubscribe',
			{ delivery: { type: 'Unsubscribed', evidence: 'provider:unsubscribe' } },
			'DeliveryIneligible',
		],
	] as const)(
		'refuses truthfully when a terminal %s fact lands between claim and apply',
		async (_label, overrides, code) => {
			const h = harness()
			const intent = await h.wake(0)
			let authorityReads = 0
			const authority = {
				currentFacts: (query: { journeyId: string | null }) =>
					Effect.suspend(() => {
						// The pre-claim read is clean; the post-claim refresh observes the fact,
						// and the service reads the same authority afterwards.
						if (++authorityReads === 2)
							h.setFacts(overrides as Partial<EligibilityFacts>)
						return h.authority.currentFacts(query)
					}),
			}
			const result = await h.execute(intent, h.build({ authority }))
			expect(result).toMatchObject({
				type: 'Refused',
				refusal: 'PreflightRefused',
				detail: code,
				applyInvocations: 0,
				providerRequest: 'none',
				sideEffects: 'attempt-recorded',
				settlement: {
					type: 'Unsettled',
					reason: expect.stringMatching(/^journey-exited:/),
				},
			})
			expect(h.applied).toHaveLength(0)
			// The refusal carries the instant it was observed, sampled from the clock.
			expect(h.attempts.rows.get(intent.idempotencyKey)?.outcome).toEqual({
				type: 'KnownNotApplied',
				reason: 'PreflightRefused',
				observedAt: h.now,
			})
			expect(h.attempts.rows.get(intent.idempotencyKey)?.status).toBe(
				'KnownNotApplied',
			)
			// The ledger records the refused intent, but the domain exits the journey
			// on the fact instead of settling the slot.
			expect(h.intentRecord(intent)?.status).toBe('Refused')
			expect(h.aggregate().phase).not.toBe('bridge.running')
			expect(h.slot(intent).status).toBe('IntentCommitted')
			expect(await h.execute(intent)).toMatchObject({ type: 'NotClaimed' })
			expect(h.applied).toHaveLength(0)
		},
	)

	it('holds, never refuses, when an operator stop lands between claim and apply, and stays held after resume', async () => {
		const h = harness({ leaseMs: 1_000 })
		const intent = await h.wake(0)
		const claimAt = h.now
		let authorityReads = 0
		const authority = {
			currentFacts: (query: { journeyId: string | null }) =>
				Effect.suspend(() => {
					if (++authorityReads === 2)
						h.setFacts({
							automationControl: {
								type: 'Stopped',
								version: 'control-v2',
								reason: 'operator-stop',
							},
						})
					return h.authority.currentFacts(query)
				}),
		}
		const stimuliBefore = h.ledger.records().stimuli.length
		const result = await h.execute(intent, h.build({ authority }))
		expect(result).toEqual({
			type: 'Abandoned',
			reason: 'AutomationStoppedAfterClaim',
			detail: 'AutomationStopped',
			applyInvocations: 0,
			providerRequest: 'none',
			sideEffects: 'mapping-persisted',
		})
		expect(h.applied).toHaveLength(0)
		// No outcome written, no stimulus: the stop is a pause, not a refusal.
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'Claimed',
			outcome: null,
			claimedAt: new Date(claimAt),
		})
		expect(h.ledger.records().stimuli).toHaveLength(stimuliBefore)
		expect(h.intentRecord(intent)?.status).toBe('Pending')
		expect(h.slot(intent).status).toBe('IntentCommitted')

		// Operator resumes. The claim is still owned by the abandoned run; nothing resends.
		h.setFacts({})
		expect(await h.execute(intent)).toEqual({
			type: 'AlreadyAttempted',
			state: 'Claimed',
			sideEffects: 'none',
		})
		h.now = plus(claimAt, 1_000)
		expect(await h.execute(intent)).toEqual({
			type: 'AlreadyAttempted',
			state: 'HeldUncertain',
			sideEffects: 'none',
		})
		const held = await Effect.runPromise(
			unpaged(h.executor.reconcileHeld({ limit: 5 })),
		)
		expect(held[0]?.result).toEqual({
			type: 'AbsentHeld',
			meaning: 'not-resend-permission',
		})
		expect(h.applied).toHaveLength(0)
		expect(h.slot(intent).status).toBe('IntentCommitted')
		expect(h.ledger.records().stimuli).toHaveLength(stimuliBefore)
	})

	it('refuses before claiming when the journey is stopped, purchased or ineligible', async () => {
		const h = harness()
		const intent = await h.wake(0)
		for (const [overrides, reason] of [
			[
				{
					automationControl: {
						type: 'Stopped',
						version: 'v2',
						reason: 'stop',
					},
				},
				'AutomationStopped',
			],
			[{ purchase }, 'PurchaseObserved'],
			[
				{ delivery: { type: 'Suppressed', evidence: 'provider:suppressed' } },
				'DeliveryIneligible',
			],
			[
				{ delivery: { type: 'Undeliverable', evidence: 'provider:bounced' } },
				'DeliveryIneligible',
			],
		] as const) {
			h.setFacts(overrides as Partial<EligibilityFacts>)
			expect(await h.execute(intent)).toEqual({
				type: 'NotClaimed',
				reason,
				sideEffects: 'none',
			})
		}
		expect(h.attempts.rows.size).toBe(0)
		expect(h.applied).toHaveLength(0)
		expect(
			await Effect.runPromise(
				h.executor.execute({
					idempotencyKey: 'missing-intent',
					journeyId: intent.journeyId,
				}),
			),
		).toEqual({
			type: 'NotClaimed',
			reason: 'IntentNotFound',
			sideEffects: 'none',
		})
		expect(
			await Effect.runPromise(
				h.executor.execute({
					idempotencyKey: intent.idempotencyKey,
					journeyId: 'evergreen-offer:unknown',
				}),
			),
		).toEqual({
			type: 'NotClaimed',
			reason: 'JourneyNotFound',
			sideEffects: 'none',
		})
	})

	it('honours exact window and lease boundaries with a fresh clock after the claim', async () => {
		const h = harness({ leaseMs: 1_000 })
		const intent = await h.wake(0)
		h.now = plus(intent.notBefore, -1)
		expect(await h.execute(intent)).toMatchObject({
			type: 'NotClaimed',
			reason: 'NotYetDue',
		})
		h.now = intent.notAfter
		expect(await h.execute(intent)).toMatchObject({
			type: 'NotClaimed',
			reason: 'WindowClosed',
		})
		expect(h.attempts.rows.size).toBe(0)

		// Lease expires exactly between the claim and the apply: nothing is sent.
		h.now = intent.notBefore
		const claimAt = h.now
		h.setDelivery(async () => {
			throw new Error('must not be called')
		})
		const leaseExpired = await h.execute(
			intent,
			h.build({
				attempts: {
					...h.attempts,
					claim: (input) =>
						Effect.tap(h.attempts.claim(input), () =>
							Effect.sync(() => {
								h.now = plus(claimAt, 1_000)
							}),
						),
				},
			}),
		)
		expect(leaseExpired).toEqual({
			type: 'Abandoned',
			reason: 'LeaseExpiredBeforeApply',
			detail: 'lease-expired',
			applyInvocations: 0,
			providerRequest: 'none',
			sideEffects: 'mapping-persisted',
		})
		expect(h.applied).toHaveLength(0)
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'Claimed',
			claimedAt: new Date(claimAt),
		})
		const held = await Effect.runPromise(
			unpaged(h.executor.reconcileHeld({ limit: 5 })),
		)
		expect(held[0]?.result.type).toBe('AbsentHeld')

		// A second slot: the window closes between claim and apply on the fresh clock.
		// No refusal is faked; the domain marks the slot Missed on its own next wake.
		const second = await h.wake(1)
		h.now = plus(second.notAfter, -1_000)
		const stimuliBefore = h.ledger.records().stimuli.length
		const windowClosed = await h.execute(
			second,
			h.build({
				leaseMs: 300_000,
				attempts: {
					...h.attempts,
					claim: (input) =>
						Effect.tap(h.attempts.claim(input), () =>
							Effect.sync(() => {
								h.now = second.notAfter
							}),
						),
				},
			}),
		)
		expect(windowClosed).toEqual({
			type: 'Abandoned',
			reason: 'WindowClosedAfterClaim',
			detail: 'WindowClosed',
			applyInvocations: 0,
			providerRequest: 'none',
			sideEffects: 'mapping-persisted',
		})
		expect(h.applied).toHaveLength(0)
		expect(h.attempts.rows.get(second.idempotencyKey)).toMatchObject({
			status: 'Claimed',
			outcome: null,
		})
		expect(h.ledger.records().stimuli).toHaveLength(stimuliBefore)
		expect(h.slot(second).status).toBe('IntentCommitted')
		expect(h.intentRecord(second)?.status).toBe('Pending')
		const third = await h.wake(2)
		expect(Date.parse(third.notBefore)).toBeGreaterThanOrEqual(
			Date.parse(second.notAfter),
		)
		expect(h.slot(second).status).toBe('Missed')
		expect(h.intentRecord(second)?.status).toBe('Missed')
	})

	it('settles a missed later receipt truthfully without a fresh send', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const crashing: Pick<EvergreenOfferJourneyService, 'advance'> = {
			advance: () =>
				Effect.fail({
					type: 'JourneyCommitUnavailable' as const,
					reason: 'process died',
				}),
		}
		const result = await h.execute(intent, h.build({ service: crashing }))
		expect(result).toMatchObject({
			type: 'Applied',
			settlement: { type: 'Failed' },
		})
		const acceptedAt = (
			h.attempts.rows.get(intent.idempotencyKey)!.outcome as AcceptedOutcome
		).appliedAt
		// B2 wakes after B1's window closed, so the domain marks B1 missed first.
		const second = await h.wake(1)
		expect(Date.parse(second.notBefore)).toBeGreaterThanOrEqual(
			Date.parse(intent.notAfter),
		)
		expect(h.intentRecord(intent)?.status).toBe('Missed')
		expect(h.slot(intent).status).toBe('Missed')
		const settled = await Effect.runPromise(
			unpaged(h.executor.settleRecordedOutcomes({ limit: 10 })),
		)
		expect(settled[0]?.settlement).toMatchObject({ type: 'Committed' })
		expect(h.intentRecord(intent)?.status).toBe('Applied')
		expect(h.slot(intent)).toMatchObject({
			status: 'Applied',
			providerReceiptId: 'fake:accepted',
		})
		expect(h.applied).toHaveLength(1)
		expect(h.ledger.records().stimuli.at(-1)?.stimulus).toMatchObject({
			type: 'DeliverySettled',
			settledAt: acceptedAt,
		})
		// The later slot is still independently executable.
		expect(await h.execute(second)).toMatchObject({ type: 'Applied' })
		expect(h.applied).toHaveLength(2)
	})

	it('holds an ambiguous provider result without a domain stimulus and keeps later slots due', async () => {
		const h = harness()
		const intent = await h.wake(0)
		h.setDelivery(async () =>
			Either.left({
				type: 'EffectAmbiguous',
				reason: 'kit-enrollment-transport-or-body-unresolved',
			}),
		)
		const stimuliBefore = h.ledger.records().stimuli.length
		expect(await h.execute(intent)).toEqual({
			type: 'HeldUncertain',
			cause: 'EffectAmbiguous',
			detail: 'kit-enrollment-transport-or-body-unresolved',
			applyInvocations: 1,
			providerRequest: 'unknown',
			sideEffects: 'attempt-recorded',
			settlement: 'none',
		})
		expect(h.ledger.records().stimuli).toHaveLength(stimuliBefore)
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'HeldUncertain',
			outcome: { type: 'HeldUncertain', reason: 'Unknown' },
		})
		expect(h.intentRecord(intent)?.status).toBe('Pending')
		expect(await h.execute(intent)).toEqual({
			type: 'AlreadyAttempted',
			state: 'HeldUncertain',
			sideEffects: 'none',
		})
		expect(h.applied).toHaveLength(1)
		expect(
			await Effect.runPromise(
				unpaged(h.executor.settleRecordedOutcomes({ limit: 10 })),
			),
		).toEqual([])

		h.setDelivery(async () =>
			Either.right({ providerReceiptId: 'fake:b2', appliedAt: h.now }),
		)
		const second = await h.wake(1)
		expect(await h.execute(second)).toMatchObject({
			type: 'Applied',
			providerReceiptId: 'fake:b2',
			settlement: { type: 'Committed' },
		})
		const third = await h.wake(2)
		expect(await h.execute(third)).toMatchObject({ type: 'Applied' })
		expect(h.applied.map((applied) => applied.slotId)).toEqual(
			[intent, second, third].map((each) => each.slotId),
		)
		expect(h.attempts.rows.get(intent.idempotencyKey)?.status).toBe(
			'HeldUncertain',
		)
	})

	it('records a permanent provider refusal as KnownNotApplied and never applies again', async () => {
		const h = harness()
		const intent = await h.wake(0)
		h.setDelivery(async () =>
			Either.left({
				type: 'EffectPermanentRefusal',
				reason: 'kit-enrollment-http-422',
			}),
		)
		expect(await h.execute(intent)).toMatchObject({
			type: 'Refused',
			refusal: 'ProviderRefused',
			detail: 'kit-enrollment-http-422',
			applyInvocations: 1,
			providerRequest: 'unknown',
			settlement: { type: 'Committed' },
		})
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'KnownNotApplied',
			outcome: {
				type: 'KnownNotApplied',
				reason: 'ProviderRefused',
				observedAt: h.now,
			},
		})
		// The slot settles at the stored observation, which is what was committed.
		expect(h.slot(intent)).toMatchObject({
			status: 'Refused',
			reason: 'provider-refused',
			settledAt: h.now,
		})
		expect(
			h.ledger
				.records()
				.stimuli.find((record) => record.stimulusId.includes(':attempt:'))
				?.stimulus,
		).toMatchObject({ type: 'DeliverySettled', settledAt: h.now })
		expect(h.intentRecord(intent)?.status).toBe('Refused')
		h.setDelivery(async () =>
			Either.right({ providerReceiptId: 'fake:retry', appliedAt: h.now }),
		)
		expect(await h.execute(intent)).toMatchObject({
			type: 'NotClaimed',
			reason: 'IntentNotPending',
		})
		expect(h.applied).toHaveLength(1)
	})

	it('holds, never refuses, when the clock fails after a provider refusal', async () => {
		const h = harness({ leaseMs: 1_000 })
		const intent = await h.wake(0)
		h.setDelivery(async () =>
			Either.left({
				type: 'EffectPermanentRefusal',
				reason: 'kit-enrollment-http-422',
			}),
		)
		// Clock works until the provider has answered, then fails at the observation.
		const executor = h.build({
			clock: {
				now: Effect.suspend(() =>
					h.applied.length > 0
						? Effect.fail({ type: 'ClockUnavailable' as const, reason: 'skew' })
						: Effect.succeed(h.now),
				),
			},
		})
		expect(
			await Effect.runPromise(
				Effect.either(executor.execute(h.target(intent))),
			),
		).toEqual(
			Either.left({
				type: 'ClockUnavailable',
				reason: 'skew',
				sideEffects: 'provider-called',
			}),
		)
		expect(h.applied).toHaveLength(1)
		// No manufactured instant: nothing recorded, nothing settled, claim still held.
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'Claimed',
			outcome: null,
		})
		expect(h.intentRecord(intent)?.status).toBe('Pending')
		expect(
			h.ledger
				.records()
				.stimuli.some((record) => record.stimulusId.includes(':attempt:')),
		).toBe(false)
		h.now = plus(h.now, 5_000)
		expect(await h.execute(intent)).toEqual({
			type: 'AlreadyAttempted',
			state: 'HeldUncertain',
			sideEffects: 'none',
		})
		expect(
			(await Effect.runPromise(h.executor.reconcileHeld({ limit: 5 })))
				.results[0]?.result.type,
		).toBe('AbsentHeld')
		expect(h.applied).toHaveLength(1)
	})

	it('fake attempt store refuses unobserved, out-of-bound and conflicting refusal writes, and never rewrites a legacy row', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const claimed = await Effect.runPromise(
			h.attempts.claim({
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				now: new Date(h.now),
				leaseExpiresAt: new Date(Date.parse(h.now) + 60_000),
			}),
		)
		if (claimed.type !== 'Claimed') throw new Error('Expected claim')
		const identity = {
			idempotencyKey: intent.idempotencyKey,
			journeyId: intent.journeyId,
			claimToken: claimed.evidence.claimToken,
		}
		const now = new Date(plus(h.now, 500))
		const refusal = {
			type: 'KnownNotApplied',
			reason: 'ProviderRefused',
		} as const
		const settle = (outcome: AttemptOutcome, at = now) =>
			Effect.runPromise(
				Effect.either(h.attempts.settle({ ...identity, now: at, outcome })),
			)
		for (const outcome of [
			refusal,
			{ ...refusal, observedAt: plus(h.now, -1) },
			{ ...refusal, observedAt: plus(h.now, 501) },
		]) {
			const result = await settle(outcome)
			expect(Either.isLeft(result) && result.left).toEqual({
				type: 'AttemptRefused',
				reason: 'Refusal observation is missing or outside claim evidence',
			})
		}
		expect(h.attempts.rows.get(intent.idempotencyKey)?.status).toBe('Claimed')
		const observed = { ...refusal, observedAt: plus(h.now, 250) }
		const first = await settle(observed)
		expect(Either.isRight(first) && first.right.outcome).toEqual(observed)
		// Exact replay reads the saved evidence; a different instant loses to the first.
		expect(await settle(observed, new Date(plus(h.now, 90_000)))).toEqual(first)
		for (const conflicting of [
			{ ...refusal, observedAt: plus(h.now, 251) },
			refusal,
		]) {
			expect(Either.isLeft(await settle(conflicting))).toBe(true)
		}
		expect(h.attempts.rows.get(intent.idempotencyKey)?.outcome).toEqual(
			observed,
		)
		// A legacy row (no observation) replays exactly and refuses an observed rewrite.
		const legacy = decodeAttempt({
			...h.attempts.rows.get(intent.idempotencyKey)!,
			outcome: refusal,
		})
		h.attempts.rows.set(intent.idempotencyKey, legacy)
		expect(await settle(refusal)).toEqual(Either.right(legacy))
		expect(Either.isLeft(await settle(observed))).toBe(true)
		expect(h.attempts.rows.get(intent.idempotencyKey)).toEqual(legacy)
	})

	it('holds a legacy refusal without an observation as an evidence gap: no stimulus, no substitute time', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const claimed = await Effect.runPromise(
			h.attempts.claim({
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				now: new Date(h.now),
				leaseExpiresAt: new Date(Date.parse(h.now) + 60_000),
			}),
		)
		if (claimed.type !== 'Claimed') throw new Error('Expected claim')
		// A row written before observations existed: status and outcome, no instant.
		const legacy = decodeAttempt({
			...claimed.evidence,
			status: 'KnownNotApplied',
			outcome: { type: 'KnownNotApplied', reason: 'ProviderRefused' },
		})
		h.attempts.rows.set(intent.idempotencyKey, legacy)
		const advances: unknown[] = []
		const recording: Pick<EvergreenOfferJourneyService, 'advance'> = {
			advance: (stimulus) =>
				Effect.suspend(() => {
					advances.push(stimulus)
					return h.service.advance(stimulus)
				}),
		}
		h.now = plus(h.now, 120_000)
		const before = h.clockReads
		const page = await Effect.runPromise(
			h.build({ service: recording }).settleRecordedOutcomes({ limit: 10 }),
		)
		const stimulusId = `${intent.idempotencyKey}:attempt:${legacy.claimToken}:delivery-settled`
		expect(page.results).toEqual([
			{
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				attemptStatus: 'KnownNotApplied',
				settlement: {
					type: 'EvidenceGap',
					stimulusId,
					reason: 'refusal-observation-missing',
				},
			},
		])
		expect(page).toMatchObject({ scanned: 1, end: true })
		expect(advances).toHaveLength(0)
		// Page plus two canonical-scope inspections. None becomes a settlement instant.
		expect(h.clockReads - before).toBe(3)
		expect(h.attempts.rows.get(intent.idempotencyKey)).toEqual(legacy)
		expect(h.intentRecord(intent)?.status).toBe('Pending')
		expect(h.slot(intent).status).toBe('IntentCommitted')
		expect(
			h.ledger
				.records()
				.stimuli.some((record) => record.stimulusId === stimulusId),
		).toBe(false)
		// A receipt already committed under the exact stimulus ID is reported as is.
		const receipt = await Effect.runPromise(
			h.ledger.findCommittedStimulus(entry.stimulusId),
		)
		if (!receipt) throw new Error('Expected the entry receipt')
		const committed = await Effect.runPromise(
			h
				.build({
					service: recording,
					ledger: {
						...h.ledger,
						findCommittedStimulus: (id: string) =>
							Effect.succeed(id === stimulusId ? receipt : null),
					},
				})
				.settleRecordedOutcomes({ limit: 10 }),
		)
		expect(committed.results[0]?.settlement).toEqual({
			type: 'AlreadyCommitted',
			stimulusId,
		})
		expect(advances).toHaveLength(0)
		expect(h.attempts.rows.get(intent.idempotencyKey)).toEqual(legacy)
	})

	it('replays a crashed refusal with a byte-identical stimulus at the stored observation, not the recovery clock', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const observedAt = h.now
		h.setDelivery(async () =>
			Either.left({
				type: 'EffectPermanentRefusal',
				reason: 'kit-enrollment-http-422',
			}),
		)
		const stimuli: unknown[] = []
		const crashing: Pick<EvergreenOfferJourneyService, 'advance'> = {
			advance: (stimulus) =>
				Effect.suspend(() => {
					stimuli.push(stimulus)
					return Effect.fail({
						type: 'JourneyCommitUnavailable' as const,
						reason: 'process died',
					})
				}),
		}
		expect(
			await h.execute(intent, h.build({ service: crashing })),
		).toMatchObject({
			type: 'Refused',
			refusal: 'ProviderRefused',
			settlement: { type: 'Failed', error: 'JourneyCommitUnavailable' },
		})
		expect(h.attempts.rows.get(intent.idempotencyKey)?.outcome).toEqual({
			type: 'KnownNotApplied',
			reason: 'ProviderRefused',
			observedAt,
		})
		expect(h.intentRecord(intent)?.status).toBe('Pending')
		const recording: Pick<EvergreenOfferJourneyService, 'advance'> = {
			advance: (stimulus) =>
				Effect.suspend(() => {
					stimuli.push(stimulus)
					return h.service.advance(stimulus)
				}),
		}
		h.now = plus(observedAt, 90_000)
		const recovered = await Effect.runPromise(
			unpaged(
				h.build({ service: recording }).settleRecordedOutcomes({ limit: 10 }),
			),
		)
		expect(recovered).toEqual([
			{
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				attemptStatus: 'KnownNotApplied',
				settlement: {
					type: 'Committed',
					stimulusId: `${intent.idempotencyKey}:attempt:${h.attempts.rows.get(intent.idempotencyKey)!.claimToken}:delivery-settled`,
				},
			},
		])
		// Live and recovery built the same full payload despite the clock moving on.
		expect(stimuli).toHaveLength(2)
		expect(stimuli[1]).toEqual(stimuli[0])
		expect(stimuli[0]).toMatchObject({
			type: 'DeliverySettled',
			settledAt: observedAt,
			outcome: { type: 'MessageRefused', reason: 'provider-refused' },
		})
		expect(h.slot(intent)).toMatchObject({
			status: 'Refused',
			settledAt: observedAt,
		})
		expect(
			await Effect.runPromise(
				unpaged(
					h.build({ service: recording }).settleRecordedOutcomes({ limit: 10 }),
				),
			),
		).toEqual([])
		expect(stimuli).toHaveLength(2)
		expect(h.applied).toHaveLength(1)
	})

	const provenNoRequest = (reason: string): EffectApplicationError => ({
		type: 'EffectTransientUnavailable',
		reason,
		requestIssued: false,
	})

	it('invokes apply again under the same claim after a proven no-request failure, then applies once', async () => {
		const h = harness()
		const intent = await h.wake(0)
		let calls = 0
		h.setDelivery(async () =>
			++calls === 1
				? Either.left(provenNoRequest('identity-unavailable'))
				: Either.right({ providerReceiptId: 'fake:second', appliedAt: h.now }),
		)
		let authorityReads = 0
		const authority = {
			currentFacts: (query: { journeyId: string | null }) =>
				Effect.suspend(() => {
					authorityReads++
					return h.authority.currentFacts(query)
				}),
		}
		const clockBefore = h.clockReads
		const result = await h.execute(intent, h.build({ authority }))
		expect(result).toMatchObject({
			type: 'Applied',
			providerReceiptId: 'fake:second',
			applyInvocations: 2,
			settlement: { type: 'Committed' },
		})
		expect(h.applied).toHaveLength(2)
		// Preflight read plus one fresh read per invocation; the clock likewise.
		expect(authorityReads).toBeGreaterThanOrEqual(3)
		expect(h.clockReads - clockBefore).toBeGreaterThanOrEqual(4)
		const rows = [...h.attempts.rows.values()]
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ status: 'Accepted' })
		expect(h.slot(intent).status).toBe('Applied')
	})

	it('abandons and holds after two proven no-request failures, never KnownNotApplied', async () => {
		const h = harness({ leaseMs: 1_000 })
		const intent = await h.wake(0)
		const claimAt = h.now
		h.setDelivery(async () =>
			Either.left(provenNoRequest('identity-unavailable')),
		)
		const stimuliBefore = h.ledger.records().stimuli.length
		expect(await h.execute(intent)).toEqual({
			type: 'Abandoned',
			reason: 'ProvenNoRequestFailuresExhausted',
			detail: 'identity-unavailable',
			applyInvocations: 2,
			providerRequest: 'none',
			sideEffects: 'mapping-persisted',
		})
		expect(h.applied).toHaveLength(2)
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'Claimed',
			outcome: null,
			claimedAt: new Date(claimAt),
		})
		expect(h.ledger.records().stimuli).toHaveLength(stimuliBefore)
		expect(h.intentRecord(intent)?.status).toBe('Pending')
		expect(h.slot(intent).status).toBe('IntentCommitted')
		// A later run sees the existing claim and never applies again, even once healthy.
		h.setDelivery(async () =>
			Either.right({ providerReceiptId: 'fake:healthy', appliedAt: h.now }),
		)
		expect(await h.execute(intent)).toMatchObject({
			type: 'AlreadyAttempted',
			state: 'Claimed',
		})
		h.now = plus(claimAt, 1_000)
		expect(await h.execute(intent)).toMatchObject({
			type: 'AlreadyAttempted',
			state: 'HeldUncertain',
		})
		const held = await Effect.runPromise(
			unpaged(h.executor.reconcileHeld({ limit: 5 })),
		)
		expect(held[0]?.result.type).toBe('AbsentHeld')
		expect(h.applied).toHaveLength(2)
	})

	it('holds without a second invocation when authority turns stopped between invocations', async () => {
		const h = harness()
		const intent = await h.wake(0)
		h.setDelivery(async () =>
			Either.left(provenNoRequest('identity-unavailable')),
		)
		let authorityReads = 0
		const authority = {
			currentFacts: (query: { journeyId: string | null }) =>
				Effect.suspend(() => {
					// Preflight and first fresh read are clean; the second fresh read sees a stop.
					if (++authorityReads === 3)
						h.setFacts({
							automationControl: {
								type: 'Stopped',
								version: 'control-v2',
								reason: 'operator-stop',
							},
						})
					return h.authority.currentFacts(query)
				}),
		}
		expect(await h.execute(intent, h.build({ authority }))).toEqual({
			type: 'Abandoned',
			reason: 'AutomationStoppedAfterClaim',
			detail: 'AutomationStopped',
			applyInvocations: 1,
			providerRequest: 'none',
			sideEffects: 'mapping-persisted',
		})
		expect(h.applied).toHaveLength(1)
		expect(h.attempts.rows.get(intent.idempotencyKey)?.status).toBe('Claimed')
		expect(h.intentRecord(intent)?.status).toBe('Pending')
	})

	it('holds without a second invocation when the lease lapses between invocations', async () => {
		const h = harness({ leaseMs: 1_000 })
		const intent = await h.wake(0)
		const claimAt = h.now
		h.setDelivery(async () => {
			h.now = plus(claimAt, 1_000)
			return Either.left(provenNoRequest('clock-unavailable'))
		})
		expect(await h.execute(intent)).toEqual({
			type: 'Abandoned',
			reason: 'LeaseExpiredBeforeApply',
			detail: 'clock-unavailable',
			applyInvocations: 1,
			providerRequest: 'none',
			sideEffects: 'mapping-persisted',
		})
		expect(h.applied).toHaveLength(1)
		expect(h.attempts.rows.get(intent.idempotencyKey)?.status).toBe('Claimed')
	})

	it('treats a transient failure without no-request proof as uncertain and never retries', async () => {
		const h = harness()
		const intent = await h.wake(0)
		h.setDelivery(async () =>
			Either.left({
				type: 'EffectTransientUnavailable',
				reason: 'socket-reset',
			}),
		)
		const stimuliBefore = h.ledger.records().stimuli.length
		expect(await h.execute(intent)).toEqual({
			type: 'HeldUncertain',
			cause: 'EffectTransientUnavailable',
			detail: 'unproven-no-request:socket-reset',
			applyInvocations: 1,
			providerRequest: 'unknown',
			sideEffects: 'attempt-recorded',
			settlement: 'none',
		})
		expect(h.applied).toHaveLength(1)
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'HeldUncertain',
			outcome: { type: 'HeldUncertain', reason: 'Unknown' },
		})
		expect(h.ledger.records().stimuli).toHaveLength(stimuliBefore)
		expect(h.intentRecord(intent)?.status).toBe('Pending')
		h.setDelivery(async () =>
			Either.right({ providerReceiptId: 'fake:healthy', appliedAt: h.now }),
		)
		expect(await h.execute(intent)).toMatchObject({
			type: 'AlreadyAttempted',
			state: 'HeldUncertain',
		})
		expect(h.applied).toHaveLength(1)
	})

	it('leaves unsupported intent types untouched without claim or provider work', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const couponIntent: SideEffectIntent = {
			type: 'IssueCoupon',
			idempotencyKey: `${intent.journeyId}:coupon.issue`,
			journeyId: intent.journeyId,
			contactId: intent.contactId,
			issueAt: intent.notBefore,
			expiresAt: intent.notAfter,
		} as unknown as SideEffectIntent
		const claim = vi.fn(h.attempts.claim)
		const ledger: JourneyLedger = {
			...h.ledger,
			inspect: (query) =>
				Effect.map(h.ledger.inspect(query), (view) => ({
					...view,
					intents: [
						...view.intents,
						{ intent: couponIntent, status: 'pending' },
					],
				})),
		}
		const executor = h.build({ ledger, attempts: { ...h.attempts, claim } })
		expect(
			await Effect.runPromise(
				executor.execute({
					idempotencyKey: couponIntent.idempotencyKey,
					journeyId: intent.journeyId,
				}),
			),
		).toEqual({
			type: 'NotClaimed',
			reason: 'UnsupportedIntentType',
			sideEffects: 'none',
		})
		expect(claim).not.toHaveBeenCalled()
		expect(h.applied).toHaveLength(0)
		expect(h.attempts.rows.size).toBe(0)
	})

	it('pages held claims past a retained first page with bounded cursors', async () => {
		const h = harness()
		const intents: SendMessageIntent[] = []
		for (const index of [0, 1, 2]) {
			const intent = await h.wake(index)
			intents.push(intent)
			await Effect.runPromise(
				h.attempts.claim({
					idempotencyKey: intent.idempotencyKey,
					journeyId: intent.journeyId,
					now: new Date(h.now),
					leaseExpiresAt: new Date(Date.parse(h.now) + 1_000),
				}),
			)
		}
		const keys = intents.map((intent) => intent.idempotencyKey)
		h.now = plus(h.now, 5_000)
		const first = await Effect.runPromise(
			h.executor.reconcileHeld({ limit: 2 }),
		)
		expect(first.results.map((item) => item.idempotencyKey)).toEqual([
			keys[0],
			keys[1],
		])
		expect(first.results.map((item) => item.result.type)).toEqual([
			'AbsentHeld',
			'AbsentHeld',
		])
		expect(first).toMatchObject({
			scanned: 2,
			end: false,
			nextCursor: {
				leaseExpiresAt: h.attempts.rows
					.get(keys[1]!)!
					.leaseExpiresAt.toISOString(),
				idempotencyKey: keys[1],
			},
		})
		// Without the cursor the retained rows come back again: the starvation itself.
		expect(
			(
				await Effect.runPromise(h.executor.reconcileHeld({ limit: 2 }))
			).results.map((item) => item.idempotencyKey),
		).toEqual([keys[0], keys[1]])
		const second = await Effect.runPromise(
			h.executor.reconcileHeld({ limit: 2, after: first.nextCursor! }),
		)
		expect(second.results.map((item) => item.idempotencyKey)).toEqual([keys[2]])
		expect(second).toMatchObject({
			scanned: 1,
			end: true,
			nextCursor: { idempotencyKey: keys[2] },
		})
		// An empty continuation keeps its cursor; end is this query, not history.
		const third = await Effect.runPromise(
			h.executor.reconcileHeld({ limit: 2, after: second.nextCursor! }),
		)
		expect(third).toEqual({
			results: [],
			scanned: 0,
			end: true,
			nextCursor: second.nextCursor,
		})
		expect([...h.attempts.rows.values()].map((row) => row.status)).toEqual([
			'Claimed',
			'Claimed',
			'Claimed',
		])
		expect(h.inspections).toHaveLength(5)
		expect(h.applied).toHaveLength(0)
	})

	it('pages recorded outcomes past a retained first page and settles the later row', async () => {
		const h = harness()
		const crashing: Pick<EvergreenOfferJourneyService, 'advance'> = {
			advance: () =>
				Effect.fail({
					type: 'JourneyCommitUnavailable' as const,
					reason: 'process died',
				}),
		}
		const broken = h.build({ service: crashing })
		const intents: SendMessageIntent[] = []
		for (const index of [0, 1, 2]) {
			const intent = await h.wake(index)
			intents.push(intent)
			expect(await h.execute(intent, broken)).toMatchObject({
				type: 'Applied',
				settlement: { type: 'Failed', error: 'JourneyCommitUnavailable' },
			})
		}
		const keys = intents.map((intent) => intent.idempotencyKey)
		h.now = plus(h.now, 1_000)
		// The first page keeps failing to settle; it is still advanced past.
		const stuck = await Effect.runPromise(
			broken.settleRecordedOutcomes({ limit: 2 }),
		)
		expect(stuck.results.map((item) => item.idempotencyKey)).toEqual([
			keys[0],
			keys[1],
		])
		expect(stuck.results.map((item) => item.settlement.type)).toEqual([
			'Failed',
			'Failed',
		])
		expect(stuck).toMatchObject({
			scanned: 2,
			end: false,
			nextCursor: { status: 'Accepted', idempotencyKey: keys[1] },
		})
		const later = await Effect.runPromise(
			h.executor.settleRecordedOutcomes({ limit: 2, after: stuck.nextCursor! }),
		)
		expect(later.results).toEqual([
			{
				idempotencyKey: keys[2],
				journeyId: intents[2]!.journeyId,
				attemptStatus: 'Accepted',
				settlement: {
					type: 'Committed',
					stimulusId: `${keys[2]}:attempt:${h.attempts.rows.get(keys[2]!)!.claimToken}:delivery-settled`,
				},
			},
		])
		expect(later).toMatchObject({ scanned: 1, end: true })
		expect(h.intentRecord(intents[2]!)?.status).toBe('Applied')
		expect(h.intentRecord(intents[0]!)?.status).not.toBe('Applied')
		// Restarting from no cursor reaches the rows the retained page left behind.
		const restart = await Effect.runPromise(
			h.executor.settleRecordedOutcomes({ limit: 2 }),
		)
		expect(
			restart.results.map((item) => [
				item.idempotencyKey,
				item.settlement.type,
			]),
		).toEqual([
			[keys[0], 'Committed'],
			[keys[1], 'Committed'],
		])
		expect(
			await Effect.runPromise(
				unpaged(h.executor.settleRecordedOutcomes({ limit: 10 })),
			),
		).toEqual([])
		expect(intents.map((intent) => h.intentRecord(intent)?.status)).toEqual([
			'Applied',
			'Applied',
			'Applied',
		])
		expect(h.applied).toHaveLength(3)
	})

	it('fails a recovery page closed as a typed error, never an empty page', async () => {
		const h = harness()
		const poisoned = h.build({
			attempts: {
				...h.attempts,
				recoveryPage: () =>
					Effect.fail({
						type: 'AttemptUnavailable' as const,
						reason: 'Attempt boundary rejected or unavailable',
					}),
				recordedOutcomeRecoveryPage: () =>
					Effect.fail({
						type: 'AttemptRefused' as const,
						reason: 'Recorded attempt ownership mismatch',
					}),
			},
		})
		expect(
			await Effect.runPromise(
				Effect.either(poisoned.reconcileHeld({ limit: 5 })),
			),
		).toMatchObject({
			_tag: 'Left',
			left: {
				type: 'AttemptUnavailable',
				reason: 'Attempt boundary rejected or unavailable',
				sideEffects: 'none',
			},
		})
		expect(
			await Effect.runPromise(
				Effect.either(poisoned.settleRecordedOutcomes({ limit: 5 })),
			),
		).toMatchObject({
			_tag: 'Left',
			left: { type: 'AttemptRefused', sideEffects: 'none' },
		})
		// Page bounds are refused before any row is read.
		for (const limit of [0, 101]) {
			expect(
				await Effect.runPromise(
					Effect.either(h.executor.reconcileHeld({ limit })),
				),
			).toMatchObject({ _tag: 'Left', left: { type: 'AttemptRefused' } })
			expect(
				await Effect.runPromise(
					Effect.either(h.executor.settleRecordedOutcomes({ limit })),
				),
			).toMatchObject({ _tag: 'Left', left: { type: 'AttemptRefused' } })
		}
		expect(h.inspections).toHaveLength(0)
	})

	/** Real Kit port over a mocked transport. `membershipAddedAt` feeds the GET page. */
	function kitHarness(
		h: ReturnType<typeof harness>,
		intent: SendMessageIntent,
		options: {
			readonly membershipAddedAt?: () => unknown
			readonly resolveIdentity?: () => Promise<unknown>
			readonly enrollmentStatus?: 200 | 201
		} = {},
	) {
		const fetcher = vi.fn(
			async (input: string | URL | Request, _init?: RequestInit) =>
				String(input).includes('/subscribers?')
					? new Response(
							JSON.stringify({
								subscribers: [
									{
										id: 42,
										state: 'active',
										added_at: options.membershipAddedAt?.(),
									},
								],
								pagination: { has_next_page: false, end_cursor: '' },
							}),
							{ status: 200 },
						)
					: new Response(
							JSON.stringify({
								subscriber: { id: 42, state: 'active', added_at: '2020-01-01' },
							}),
							{ status: options.enrollmentStatus ?? 201 },
						),
		)
		const kit = createKitDeliveryPort({
			fetch: fetcher as unknown as typeof fetch,
			apiKey: 'test-only',
			bindings: EVERGREEN_OFFER_JOURNEY_V1.bridge.map((message, index) => ({
				contentResourceId: message.contentResourceId,
				sequenceId: 17 + index,
				readback: {
					sequenceId: 17 + index,
					repeat: false,
					emailCount: 1,
					published: true,
					active: true,
					hold: false,
				},
			})),
			resolveIdentity:
				options.resolveIdentity ??
				(async () => ({ contactId: intent.contactId, subscriberId: 42 })),
			now: () => h.now,
			timeoutMs: 50,
		})
		const executor = h.build({
			delivery: kit,
			reconciliation: createKitMembershipReconciliation({
				port: kit,
				clock: { now: Effect.sync(() => h.now) },
			}),
		})
		const posts = () =>
			fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').length
		return { fetcher, executor, posts }
	}

	it('records a real Kit 201 acknowledgement at the port clock as acceptance, not inbox delivery', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const { fetcher, executor, posts } = kitHarness(h, intent, {
			enrollmentStatus: 201,
		})
		const result = await h.execute(intent, executor)
		// appliedAt is the port's clock read after Kit's 201, not Kit's added_at.
		expect(result).toMatchObject({
			type: 'Applied',
			meaning: 'provider-accepted-not-inbox-delivery',
			providerReceiptId: 'kit:sequence:17:subscriber:42:added',
			appliedAt: h.now,
			applyInvocations: 1,
			settlement: { type: 'Committed' },
		})
		expect(posts()).toBe(1)
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(h.slot(intent)).toMatchObject({
			status: 'Applied',
			providerReceiptId: 'kit:sequence:17:subscriber:42:added',
		})
	})

	it('holds a real Kit 200 already-member answer uncertain after one POST, then binds only the provider added_at by GET', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const claimAt = h.now
		let addedAt: unknown = '2020-01-01T00:00:00Z'
		const { fetcher, executor, posts } = kitHarness(h, intent, {
			enrollmentStatus: 200,
			membershipAddedAt: () => addedAt,
		})
		const result = await h.execute(intent, executor)
		// 200 means the subscriber was already a member. Application of this intent is
		// unknown, so no fresh acceptance time exists and nothing is settled.
		expect(result).toEqual({
			type: 'HeldUncertain',
			cause: 'EffectAmbiguous',
			detail: KIT_ALREADY_MEMBER_REASON,
			applyInvocations: 1,
			providerRequest: 'unknown',
			sideEffects: 'attempt-recorded',
			settlement: 'none',
		})
		expect(posts()).toBe(1)
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'HeldUncertain',
			outcome: { type: 'HeldUncertain', reason: 'Unknown' },
		})
		expect(h.slot(intent).status).toBe('IntentCommitted')
		expect(h.intentRecord(intent)?.status).toBe('Pending')
		// The provider instant that explains the 200 predates this claim: held as evidence.
		h.now = plus(claimAt, 5_000)
		const prior = await Effect.runPromise(executor.reconcileHeld({ limit: 5 }))
		expect(prior.results[0]?.result).toEqual({
			type: 'MembershipHeld',
			reason: 'PrecedesClaim',
			addedAt: '2020-01-01T00:00:00.000Z',
			observedAt: h.now,
		})
		expect(h.attempts.rows.get(intent.idempotencyKey)?.status).toBe(
			'HeldUncertain',
		)
		expect(h.slot(intent).status).toBe('IntentCommitted')
		// Only a provider instant inside this claim and window settles, at that instant.
		addedAt = plus(claimAt, 750)
		const bound = await Effect.runPromise(executor.reconcileHeld({ limit: 5 }))
		expect(bound.results[0]?.result).toMatchObject({
			type: 'ReconciledAccepted',
			addedAt: plus(claimAt, 750),
			observedAt: h.now,
			settlement: { type: 'Committed' },
		})
		expect(h.attempts.rows.get(intent.idempotencyKey)?.outcome).toMatchObject({
			type: 'Accepted',
			appliedAt: plus(claimAt, 750),
		})
		expect(h.slot(intent)).toMatchObject({ status: 'Applied' })
		expect(posts()).toBe(1)
		expect(fetcher).toHaveBeenCalledTimes(3)
	})

	it('reconciles a held claim through Kit GET only when the provider added_at binds to the claim', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const claimAt = h.now
		let addedAt: unknown = undefined
		const { fetcher, executor, posts } = kitHarness(h, intent, {
			membershipAddedAt: () => addedAt,
		})
		await Effect.runPromise(
			h.attempts.claim({
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				now: new Date(h.now),
				leaseExpiresAt: new Date(Date.parse(h.now) + 1_000),
			}),
		)
		h.now = plus(claimAt, 5_000)
		// No usable provider instant: presence alone cannot be bound.
		expect(
			(
				await Effect.runPromise(unpaged(executor.reconcileHeld({ limit: 5 })))
			)[0]?.result,
		).toEqual({ type: 'UnknownHeld', reason: 'membership-added-at-unknown' })
		// Real membership from before this claim stays held as evidence.
		addedAt = '2020-01-01T00:00:00Z'
		expect(
			(
				await Effect.runPromise(unpaged(executor.reconcileHeld({ limit: 5 })))
			)[0]?.result,
		).toEqual({
			type: 'MembershipHeld',
			reason: 'PrecedesClaim',
			addedAt: '2020-01-01T00:00:00.000Z',
			observedAt: h.now,
		})
		expect(h.attempts.rows.get(intent.idempotencyKey)?.status).toBe('Claimed')
		// The provider instant inside this claim and window is the acceptance time.
		addedAt = plus(claimAt, 1_250)
		const reconciled = await Effect.runPromise(
			unpaged(executor.reconcileHeld({ limit: 5 })),
		)
		expect(reconciled[0]?.result).toMatchObject({
			type: 'ReconciledAccepted',
			providerReceiptId: `kit:sequence-membership-observed:${intent.contentResourceId}`,
			addedAt: plus(claimAt, 1_250),
			observedAt: h.now,
			settlement: { type: 'Committed' },
		})
		expect(h.attempts.rows.get(intent.idempotencyKey)?.outcome).toMatchObject({
			appliedAt: plus(claimAt, 1_250),
		})
		expect(fetcher).toHaveBeenCalledTimes(3)
		expect(posts()).toBe(0)
	})

	it('issues exactly one POST when Kit identity fails once with no-request proof', async () => {
		const h = harness()
		const intent = await h.wake(0)
		let identityCalls = 0
		const { executor, posts } = kitHarness(h, intent, {
			enrollmentStatus: 201,
			resolveIdentity: async () => {
				if (++identityCalls === 1) throw new Error('identity store unavailable')
				return { contactId: intent.contactId, subscriberId: 42 }
			},
		})
		expect(await h.execute(intent, executor)).toMatchObject({
			type: 'Applied',
			providerReceiptId: 'kit:sequence:17:subscriber:42:added',
			applyInvocations: 2,
			settlement: { type: 'Committed' },
		})
		expect(posts()).toBe(1)
		expect(h.attempts.rows.get(intent.idempotencyKey)?.status).toBe('Accepted')
	})

	it('issues no POST and holds when Kit identity keeps failing with no-request proof', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const { fetcher, executor } = kitHarness(h, intent, {
			resolveIdentity: async () => {
				throw new Error('identity store unavailable')
			},
		})
		expect(await h.execute(intent, executor)).toEqual({
			type: 'Abandoned',
			reason: 'ProvenNoRequestFailuresExhausted',
			detail: 'identity-unavailable',
			applyInvocations: 2,
			providerRequest: 'none',
			sideEffects: 'mapping-persisted',
		})
		expect(fetcher).not.toHaveBeenCalled()
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'Claimed',
			outcome: null,
		})
		expect(h.intentRecord(intent)?.status).toBe('Pending')
	})

	it('reads the clock again at every boundary instead of reusing the claim instant', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const before = h.clockReads
		await h.execute(intent)
		// Preflight, claim refresh, attempt record, and the service's own commit clock.
		expect(h.clockReads - before).toBeGreaterThanOrEqual(3)
		const attempt = h.attempts.rows.get(intent.idempotencyKey)!
		expect(attempt.claimedAt.toISOString()).toBe(h.now)
	})

	it('fails closed on authority and clock errors without side effects', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const brokenAuthority = h.build({
			authority: {
				currentFacts: () =>
					Effect.fail({
						type: 'AuthorityUnavailable' as const,
						reason: 'down',
					}),
			},
		})
		const authorityResult = await Effect.runPromise(
			Effect.either(brokenAuthority.execute(h.target(intent))),
		)
		expect(authorityResult).toEqual(
			Either.left({
				type: 'AuthorityUnavailable',
				reason: 'down',
				sideEffects: 'none',
			}),
		)
		const brokenClock = h.build({
			clock: {
				now: Effect.fail({ type: 'ClockUnavailable' as const, reason: 'skew' }),
			},
		})
		const clockResult = await Effect.runPromise(
			Effect.either(brokenClock.execute(h.target(intent))),
		)
		expect(clockResult).toEqual(
			Either.left({
				type: 'ClockUnavailable',
				reason: 'skew',
				sideEffects: 'none',
			}),
		)
		expect(h.attempts.rows.size).toBe(0)
		expect(h.applied).toHaveLength(0)
		const invalid = await Effect.runPromise(
			Effect.either(h.executor.execute({ idempotencyKey: '', journeyId: 'x' })),
		)
		expect(Either.isLeft(invalid) && invalid.left.type).toBe('InvalidTarget')
	})

	it('records a slow provider acceptance whose lease lapsed as exact-token evidence, never a resend', async () => {
		const h = harness({ leaseMs: 1_000 })
		const intent = await h.wake(0)
		const claimAt = h.now
		h.setDelivery(async () => {
			// The provider accepted after the lease expired; the token is still exact.
			h.now = plus(claimAt, 5_000)
			return Either.right({ providerReceiptId: 'fake:slow', appliedAt: h.now })
		})
		const result = await h.execute(intent)
		expect(result).toMatchObject({
			type: 'Applied',
			providerReceiptId: 'fake:slow',
			settlement: { type: 'Committed' },
		})
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'Accepted',
			claimedAt: new Date(claimAt),
			outcome: { providerReceiptId: 'fake:slow', appliedAt: h.now },
		})
		expect(h.slot(intent).status).toBe('Applied')
		expect(h.applied).toHaveLength(1)
		expect(
			await Effect.runPromise(unpaged(h.executor.reconcileHeld({ limit: 5 }))),
		).toEqual([])
	})
})
