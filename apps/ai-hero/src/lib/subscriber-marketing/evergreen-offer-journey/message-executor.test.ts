import { randomUUID } from 'node:crypto'
import { Effect, Either } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
	attemptStateAt,
	decodeAttempt,
	type AcceptedOutcome,
	type AttemptEvidence,
	type AttemptOutcome,
} from './attempt-evidence'
import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import type {
	CourseSequenceExhausted,
	EligibilityFacts,
	EvergreenOfferJourneyAggregate,
	SendMessageIntent,
	SideEffectIntent,
} from './domain'
import { makeInMemoryJourneyLedger } from './in-memory-ledger'
import { createKitDeliveryPort } from './kit-delivery'
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
		recovery: (input) =>
			run(() =>
				[...rows.values()]
					.filter(
						(row) =>
							(row.status === 'Claimed' && row.leaseExpiresAt <= input.now) ||
							row.status === 'HeldUncertain',
					)
					.slice(0, input.limit)
					.map((evidence) => ({ evidence, state: 'HeldUncertain' as const })),
			),
		recordedOutcomeRecovery: (input) =>
			run(() => {
				const recovered: {
					evidence: AttemptEvidence
					intent: SideEffectIntent
				}[] = []
				for (const evidence of rows.values()) {
					if (!['Accepted', 'KnownNotApplied'].includes(evidence.status))
						continue
					const row = intentRow(evidence.idempotencyKey)
					if (!row) continue
					if (
						row.status === 'Pending' ||
						(row.status === 'Missed' && row.intent.type === 'SendMessage')
					)
						recovered.push({ evidence, intent: row.intent })
				}
				return recovered.slice(0, input.limit)
			}),
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

function harness(options: { readonly leaseMs?: number } = {}) {
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
		definition: EVERGREEN_OFFER_JOURNEY_V1,
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
		const started = await Effect.runPromise(service.advance(entry))
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
			h.executor.reconcileHeld({ limit: 10 }),
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
			h.executor.reconcileHeld({ limit: 10 }),
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
		h.now = plus(h.now, 2_000)
		h.setMembership({
			type: 'Present',
			providerReceiptId: 'kit:sequence-membership-observed:b1',
			observedAt: h.now,
		})
		const recovered = await Effect.runPromise(
			h.executor.reconcileHeld({ limit: 10 }),
		)
		expect(recovered).toEqual([
			{
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				result: {
					type: 'ReconciledAccepted',
					providerReceiptId: 'kit:sequence-membership-observed:b1',
					observedAt: h.now,
					settlement: { type: 'Committed', stimulusId: expect.any(String) },
				},
				sideEffects: 'attempt-recorded',
			},
		])
		expect(h.applied).toHaveLength(0)
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'Accepted',
			claimToken: claimed.evidence.claimToken,
			outcome: { appliedAt: h.now },
		})
		expect(h.intentRecord(intent)?.status).toBe('Applied')
		expect(
			await Effect.runPromise(h.executor.reconcileHeld({ limit: 10 })),
		).toEqual([])
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
			h.executor.settleRecordedOutcomes({ limit: 10 }),
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
			await Effect.runPromise(h.executor.settleRecordedOutcomes({ limit: 10 })),
		).toEqual([])
		expect(h.applied).toHaveLength(1)
	})

	it.each([
		['purchase', { purchase }, 'PurchaseObserved', 'Unsettled'],
		[
			'unsubscribe',
			{ delivery: { type: 'Unsubscribed', evidence: 'provider:unsubscribe' } },
			'DeliveryIneligible',
			'Unsettled',
		],
		[
			'operator stop',
			{
				automationControl: {
					type: 'Stopped',
					version: 'control-v2',
					reason: 'operator-stop',
				},
			},
			'AutomationStopped',
			'Committed',
		],
	] as const)(
		'blocks the provider call when %s lands between claim and apply',
		async (_label, overrides, code, settlementType) => {
			const h = harness()
			const intent = await h.wake(0)
			let authorityReads = 0
			const authority = {
				currentFacts: (query: { journeyId: string | null }) =>
					Effect.suspend(() => {
						// The pre-claim read is clean; the post-claim refresh observes the stop,
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
				sideEffects: 'attempt-recorded',
				settlement: { type: settlementType },
			})
			expect(h.applied).toHaveLength(0)
			expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
				status: 'KnownNotApplied',
				outcome: { type: 'KnownNotApplied', reason: 'PreflightRefused' },
			})
			if (settlementType === 'Committed') {
				expect(h.intentRecord(intent)?.status).toBe('Refused')
				expect(h.slot(intent).status).toBe('Refused')
			} else {
				// The ledger records the refused intent, but the domain exits the journey
				// on the stop fact instead of settling the slot.
				expect(h.intentRecord(intent)?.status).toBe('Refused')
				expect(h.aggregate().phase).not.toBe('bridge.running')
				expect(h.slot(intent).status).toBe('IntentCommitted')
				expect(result).toMatchObject({
					settlement: { reason: expect.stringMatching(/^journey-exited:/) },
				})
			}
			expect(await h.execute(intent)).toMatchObject({ type: 'NotClaimed' })
			expect(h.applied).toHaveLength(0)
		},
	)

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
			sideEffects: 'claimed',
		})
		expect(h.applied).toHaveLength(0)
		expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
			status: 'Claimed',
			claimedAt: new Date(claimAt),
		})
		const held = await Effect.runPromise(h.executor.reconcileHeld({ limit: 5 }))
		expect(held[0]?.result.type).toBe('AbsentHeld')

		// A second slot: the window closes between claim and apply on the fresh clock.
		const second = await h.wake(1)
		h.now = plus(second.notAfter, -1_000)
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
		expect(windowClosed).toMatchObject({
			type: 'Refused',
			refusal: 'PreflightRefused',
			detail: 'WindowClosed',
			settlement: { type: 'Committed' },
		})
		expect(h.applied).toHaveLength(0)
		expect(h.attempts.rows.get(second.idempotencyKey)?.status).toBe(
			'KnownNotApplied',
		)
		expect(h.slot(second).status).toBe('Refused')
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
			h.executor.settleRecordedOutcomes({ limit: 10 }),
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
			detail: 'kit-enrollment-transport-or-body-unresolved',
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
			await Effect.runPromise(h.executor.settleRecordedOutcomes({ limit: 10 })),
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

	it.each([
		[
			'permanent refusal',
			{ type: 'EffectPermanentRefusal', reason: 'kit-enrollment-http-422' },
			'ProviderRefused',
			'provider-refused',
		],
		[
			'transient failure before any request',
			{ type: 'EffectTransientUnavailable', reason: 'identity-unavailable' },
			'PreflightRefused',
			'executor-preflight-refused',
		],
	] as const)(
		'records %s as KnownNotApplied and never applies again',
		async (_label, error, refusal, reason) => {
			const h = harness()
			const intent = await h.wake(0)
			h.setDelivery(async () => Either.left(error))
			expect(await h.execute(intent)).toMatchObject({
				type: 'Refused',
				refusal,
				detail: error.reason,
				settlement: { type: 'Committed' },
			})
			expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
				status: 'KnownNotApplied',
				outcome: { type: 'KnownNotApplied', reason: refusal },
			})
			expect(h.slot(intent)).toMatchObject({ status: 'Refused', reason })
			expect(h.intentRecord(intent)?.status).toBe('Refused')
			h.setDelivery(async () =>
				Either.right({ providerReceiptId: 'fake:retry', appliedAt: h.now }),
			)
			expect(await h.execute(intent)).toMatchObject({
				type: 'NotClaimed',
				reason: 'IntentNotPending',
			})
			expect(h.applied).toHaveLength(1)
		},
	)

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

	it('treats a real Kit 200 enrollment as acceptance, not inbox delivery', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const fetcher = vi.fn(
			async (input: string | URL | Request, _init?: RequestInit) =>
				String(input).includes('/subscribers?')
					? new Response(
							JSON.stringify({
								subscribers: [{ id: 42, state: 'active' }],
								pagination: { has_next_page: false, end_cursor: '' },
							}),
							{ status: 200 },
						)
					: new Response(
							JSON.stringify({
								subscriber: { id: 42, state: 'active', added_at: '2020-01-01' },
							}),
							{ status: 200 },
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
			resolveIdentity: async () => ({
				contactId: intent.contactId,
				subscriberId: 42,
			}),
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
		const result = await h.execute(intent, executor)
		expect(result).toMatchObject({
			type: 'Applied',
			meaning: 'provider-accepted-not-inbox-delivery',
			providerReceiptId: 'kit:sequence:17:subscriber:42:already-member',
			appliedAt: h.now,
			settlement: { type: 'Committed' },
		})
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
		expect(h.slot(intent)).toMatchObject({
			status: 'Applied',
			providerReceiptId: 'kit:sequence:17:subscriber:42:already-member',
		})

		// GET-only reconciliation of a held claim on the next slot names an observation.
		const second = await h.wake(1)
		await Effect.runPromise(
			h.attempts.claim({
				idempotencyKey: second.idempotencyKey,
				journeyId: second.journeyId,
				now: new Date(h.now),
				leaseExpiresAt: new Date(Date.parse(h.now) + 1_000),
			}),
		)
		h.now = plus(h.now, 5_000)
		const reconciled = await Effect.runPromise(
			executor.reconcileHeld({ limit: 5 }),
		)
		expect(reconciled[0]?.result).toMatchObject({
			type: 'ReconciledAccepted',
			providerReceiptId: `kit:sequence-membership-observed:${second.contentResourceId}`,
			observedAt: h.now,
		})
		expect(fetcher).toHaveBeenCalledTimes(2)
		expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'GET' })
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
			await Effect.runPromise(h.executor.reconcileHeld({ limit: 5 })),
		).toEqual([])
	})
})
