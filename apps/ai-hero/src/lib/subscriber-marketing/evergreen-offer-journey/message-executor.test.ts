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
			h.executor.reconcileHeld({ limit: 10 }),
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
			await Effect.runPromise(h.executor.reconcileHeld({ limit: 10 })),
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
				h.executor.reconcileHeld({ limit: 10 }),
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
			h.executor.reconcileHeld({ limit: 10 }),
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
			expect(h.attempts.rows.get(intent.idempotencyKey)).toMatchObject({
				status: 'KnownNotApplied',
				outcome: { type: 'KnownNotApplied', reason: 'PreflightRefused' },
			})
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
			sideEffects: 'claimed',
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
		const held = await Effect.runPromise(h.executor.reconcileHeld({ limit: 5 }))
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
			sideEffects: 'claimed',
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
			outcome: { type: 'KnownNotApplied', reason: 'ProviderRefused' },
		})
		expect(h.slot(intent)).toMatchObject({
			status: 'Refused',
			reason: 'provider-refused',
		})
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
			sideEffects: 'claimed',
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
		const held = await Effect.runPromise(h.executor.reconcileHeld({ limit: 5 }))
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
			sideEffects: 'claimed',
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
			sideEffects: 'claimed',
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
							{ status: options.enrollmentStatus ?? 200 },
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

	it('treats a real Kit 200 already-member acknowledgement as acceptance at the local clock (known gap), not inbox delivery', async () => {
		const h = harness()
		const intent = await h.wake(0)
		const { fetcher, executor } = kitHarness(h, intent)
		const result = await h.execute(intent, executor)
		// Truth test: Kit answered 200 (already a member, added 2020-01-01) and the port
		// stamps appliedAt from its clock. The executor cannot distinguish this from a
		// fresh enrollment through the DeliveryPort contract. See the report.
		expect(result).toMatchObject({
			type: 'Applied',
			meaning: 'provider-accepted-not-inbox-delivery',
			providerReceiptId: 'kit:sequence:17:subscriber:42:already-member',
			appliedAt: h.now,
			applyInvocations: 1,
			settlement: { type: 'Committed' },
		})
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
		expect(h.slot(intent)).toMatchObject({
			status: 'Applied',
			providerReceiptId: 'kit:sequence:17:subscriber:42:already-member',
		})
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
			(await Effect.runPromise(executor.reconcileHeld({ limit: 5 })))[0]
				?.result,
		).toEqual({ type: 'UnknownHeld', reason: 'membership-added-at-unknown' })
		// Real membership from before this claim stays held as evidence.
		addedAt = '2020-01-01T00:00:00Z'
		expect(
			(await Effect.runPromise(executor.reconcileHeld({ limit: 5 })))[0]
				?.result,
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
			executor.reconcileHeld({ limit: 5 }),
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
			sideEffects: 'claimed',
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
			await Effect.runPromise(h.executor.reconcileHeld({ limit: 5 })),
		).toEqual([])
	})
})
