import { Effect } from 'effect'
import { expect, it } from 'vitest'
import { couponExecutorFixture, instant } from './coupon-executor.fixtures'
import { createCouponIntentExecutor } from './coupon-executor'

it.each(['issue', 'bind'] as const)(
	'claims once for concurrent %s runners and preserves original operation time',
	async (kind) => {
		const f = await couponExecutorFixture()
		const intent = kind === 'bind' ? await f.prepareBinding() : f.issue
		const before = f.state.mutations
		const results = await Promise.all(
			[1, 2].map(() =>
				Effect.runPromise(
					f.executor.execute({
						journeyId: intent.journeyId,
						idempotencyKey: intent.idempotencyKey,
					}),
				),
			),
		)
		expect(f.state.mutations - before).toBe(1)
		expect(results.some((r) => r.type === 'Committed')).toBe(true)
		const evidence = f.records.get(intent.idempotencyKey)!
		expect(evidence.outcome?.type).toBe('Accepted')
		if (evidence.outcome?.type !== 'Accepted')
			throw new Error('Missing outcome')
		expect(evidence.outcome.appliedAt).toBe(f.getNow())
		expect(evidence.outcome.appliedAt > f.issue.issueAt).toBe(true)
	},
)

it.each(['after-commerce', 'after-attempt'] as const)(
	'recovers %s without another mutation, including revoked/used historical rows',
	async (point) => {
		const f = await couponExecutorFixture()
		f.state.failRecord = point === 'after-commerce'
		f.state.failDomain = point === 'after-attempt'
		expect((await Effect.runPromise(f.executor.execute(f.request))).type).toBe(
			'Failed',
		)
		f.state.failRecord = false
		f.state.failDomain = false
		f.state.couponStatus = 0
		f.state.usedCount = 1
		const result =
			point === 'after-commerce'
				? await Effect.runPromise(
						f.executor.recoverUncertainPage({
							now: new Date(f.getNow()),
							limit: 10,
						}),
					)
				: await Effect.runPromise(
						f.executor.recoverRecordedPage({
							now: new Date(f.getNow()),
							limit: 10,
						}),
					)
		expect(result.results[0]?.type).toBe('Committed')
		expect(result.results[0]?.mutation).toBe('NotAttempted')
		expect(f.state.mutations).toBe(1)
		const replay = await Effect.runPromise(
			f.executor.recoverRecordedPage({ now: new Date(f.getNow()), limit: 10 }),
		)
		expect(replay.results[0]?.type).toBe('AlreadyCommitted')
	},
)

it.each(['unknown', 'legacy', 'preclaim', 'future'] as const)(
	'holds %s issue history without reissue',
	async (mode) => {
		const f = await couponExecutorFixture()
		f.state.failRecord = true
		await Effect.runPromise(f.executor.execute(f.request))
		f.state.failRecord = false
		if (mode === 'unknown') f.state.unknownHistory = true
		if (mode === 'legacy') f.state.legacyHistory = true
		if (mode === 'preclaim') f.state.operationAt = f.issue.issueAt
		if (mode === 'future')
			f.state.operationAt = instant(
				new Date(Date.parse(f.getNow()) + 1).toISOString(),
			)
		const page = await Effect.runPromise(
			f.executor.recoverUncertainPage({ now: new Date(f.getNow()), limit: 1 }),
		)
		expect(page.results[0]?.type).toBe('Held')
		expect(f.state.mutations).toBe(1)
	},
)

it('rechecks control after claim and abandons held without terminal refusal', async () => {
	const f = await couponExecutorFixture()
	f.state.denyAfterClaim = true
	const result = await Effect.runPromise(f.executor.execute(f.request))
	expect(result).toMatchObject({ type: 'Held', mutation: 'NotAttempted' })
	expect(f.state.mutations).toBe(0)
	expect(f.records.get(f.request.idempotencyKey)?.status).toBe('Claimed')
})

it('accepts a slow return through original-token reconciliation without extending lease', async () => {
	const f = await couponExecutorFixture()
	f.state.slow = true
	expect((await Effect.runPromise(f.executor.execute(f.request))).type).toBe(
		'Committed',
	)
	const row = f.records.get(f.request.idempotencyKey)!
	expect(row.leaseExpiresAt < new Date(f.getNow())).toBe(true)
	expect(row.outcome?.type).toBe('Accepted')
})

it('uses persisted refusal time for full deterministic replay, never recovery now', async () => {
	const f = await couponExecutorFixture()
	f.state.failDomain = true
	f.state.effectError = {
		type: 'EffectPermanentRefusal',
		reason: 'synthetic refusal',
	}
	await Effect.runPromise(f.executor.execute(f.request))
	const saved = f.records.get(f.request.idempotencyKey)!
	expect(saved.outcome).toMatchObject({
		type: 'KnownNotApplied',
		observedAt: f.getNow(),
	})
	f.state.failDomain = false
	f.setNow(new Date(Date.parse(f.getNow()) + 1000).toISOString())
	const first = await Effect.runPromise(
		f.executor.recoverRecordedPage({ now: new Date(f.getNow()), limit: 10 }),
	)
	expect(first.results[0]?.type).toBe('Committed')
	f.setNow(new Date(Date.parse(f.getNow()) + 1000).toISOString())
	expect(
		(
			await Effect.runPromise(
				f.executor.recoverRecordedPage({
					now: new Date(f.getNow()),
					limit: 10,
				}),
			)
		).results[0]?.type,
	).toBe('AlreadyCommitted')
	expect(f.state.mutations).toBe(1)
})

it('propagates page failures instead of an empty success', async () => {
	const f = await couponExecutorFixture()
	const executor = createCouponIntentExecutor({
		...f.dependencies,
		attempts: {
			...f.dependencies.attempts,
			recoveryPage: () =>
				Effect.fail({ type: 'AttemptUnavailable', reason: 'unavailable' }),
		},
	})
	const result = await Effect.runPromise(
		Effect.either(executor.recoverUncertainPage({ now: new Date(), limit: 1 })),
	)
	expect(result._tag).toBe('Left')
})

it.each(['purchase', 'unsubscribe', 'unavailable', 'clock'] as const)(
	'holds %s arriving between claim and application with zero mutations',
	async (mode) => {
		const f = await couponExecutorFixture()
		let reads = 0
		const executor = createCouponIntentExecutor({
			...f.dependencies,
			authority: {
				currentFacts: (args) =>
					Effect.gen(function* () {
						const facts = yield* f.dependencies.authority.currentFacts(args)
						if (++reads < 2) return facts
						if (mode === 'unavailable')
							return yield* Effect.fail({
								type: 'AuthorityUnavailable' as const,
								reason: 'test',
							})
						if (mode === 'clock') {
							f.setNow(f.issue.issueAt)
							return facts
						}
						if (mode === 'purchase')
							return {
								...facts,
								purchase: {
									purchaseId: 'synthetic',
									offerProductFamily: 'ai-coding-crash-course' as const,
									sourceProductId: 'test',
									purchasedAt: facts.readAt,
									sourceReference: 'test',
								},
							}
						return {
							...facts,
							delivery: { type: 'Unsubscribed' as const, evidence: 'test' },
						}
					}),
			},
		})
		const result = await Effect.runPromise(executor.execute(f.request))
		expect(result.mutation).toBe('NotAttempted')
		expect(f.state.mutations).toBe(0)
		expect(f.records.size).toBe(1)
	},
)

it('never claims unsupported canonical message work', async () => {
	const f = await couponExecutorFixture()
	const view = await Effect.runPromise(
		f.ledger.inspect({
			journeyId: f.issue.journeyId,
			now: f.getNow(),
			automationControl: 'Stopped',
		}),
	)
	const intent = view.intents.find(
		(row) => row.intent.type === 'SendMessage',
	)?.intent
	expect(intent).toBeDefined()
	if (!intent) throw new Error('fixture has no message')
	expect(
		(
			await Effect.runPromise(
				f.executor.execute({
					journeyId: intent.journeyId,
					idempotencyKey: intent.idempotencyKey,
				}),
			)
		).reason,
	).toBe('Unsupported intent')
	expect(f.records.size).toBe(0)
})

it('holds legacy terminal refusal without domain advance or timestamp backfill', async () => {
	const f = await couponExecutorFixture()
	f.state.failDomain = true
	f.state.effectError = { type: 'EffectPermanentRefusal', reason: 'refusal' }
	await Effect.runPromise(f.executor.execute(f.request))
	const row = f.records.get(f.request.idempotencyKey)!
	f.records.set(row.idempotencyKey, {
		...row,
		outcome: { type: 'KnownNotApplied', reason: 'ProviderRefused' },
	})
	f.state.failDomain = false
	const page = await Effect.runPromise(
		f.executor.recoverRecordedPage({ now: new Date(f.getNow()), limit: 1 }),
	)
	expect(page.results[0]?.type).toBe('Held')
	expect(f.records.get(row.idempotencyKey)?.outcome).not.toHaveProperty(
		'observedAt',
	)
})

it('bind recovery uses binding time even with unknown legacy issue observation', async () => {
	const f = await couponExecutorFixture()
	const bind = await f.prepareBinding()
	f.state.failDomain = true
	await Effect.runPromise(
		f.executor.execute({
			journeyId: bind.journeyId,
			idempotencyKey: bind.idempotencyKey,
		}),
	)
	f.state.legacyHistory = true
	f.state.failDomain = false
	const page = await Effect.runPromise(
		f.executor.recoverRecordedPage({ now: new Date(f.getNow()), limit: 10 }),
	)
	expect(page.results.at(-1)?.type).toBe('Committed')
	expect(f.state.mutations).toBe(2)
})

it('passes the page cursor past a foreign first row without claiming it', async () => {
	const f = await couponExecutorFixture()
	f.state.failDomain = true
	await Effect.runPromise(f.executor.execute(f.request))
	f.state.failDomain = false
	const view = await Effect.runPromise(
		f.ledger.inspect({
			journeyId: f.issue.journeyId,
			now: f.getNow(),
			automationControl: 'Stopped',
		}),
	)
	const foreign = view.intents.find(
		(row) => row.intent.type === 'SendMessage',
	)!.intent
	const evidence = f.records.get(f.issue.idempotencyKey)!
	const cursor = {
		status: 'Accepted' as const,
		leaseExpiresAt: evidence.leaseExpiresAt.toISOString(),
		idempotencyKey: foreign.idempotencyKey,
	}
	const executor = createCouponIntentExecutor({
		...f.dependencies,
		attempts: {
			...f.dependencies.attempts,
			recordedOutcomeRecoveryPage: (request) =>
				request.after
					? f.dependencies.attempts.recordedOutcomeRecoveryPage(request)
					: Effect.succeed({
							candidates: [
								{
									intent: foreign,
									evidence: {
										...evidence,
										idempotencyKey: foreign.idempotencyKey,
									},
								},
							],
							scanned: 1,
							end: false,
							nextCursor: cursor,
						}),
		},
	})
	const first = await Effect.runPromise(
		executor.recoverRecordedPage({ now: new Date(f.getNow()), limit: 1 }),
	)
	expect(first.results[0]?.type).toBe('Held')
	expect(first.nextCursor).toEqual(cursor)
	expect(first.end).toBe(false)
	const second = await Effect.runPromise(
		executor.recoverRecordedPage({
			now: new Date(f.getNow()),
			limit: 1,
			after: first.nextCursor!,
		}),
	)
	expect(second.results[0]?.type).toBe('Committed')
	expect(f.state.mutations).toBe(1)
})

it.each(['EffectAmbiguous', 'EffectTransientUnavailable'] as const)(
	'does not retry %s',
	async (type) => {
		const f = await couponExecutorFixture()
		f.state.effectError = { type, reason: 'synthetic' }
		expect((await Effect.runPromise(f.executor.execute(f.request))).type).toBe(
			'Held',
		)
		await Effect.runPromise(f.executor.execute(f.request))
		expect(f.state.mutations).toBe(1)
		expect(f.records.get(f.issue.idempotencyKey)?.status).toBe('Claimed')
	},
)

it('holds a conflicting historical receipt instead of advancing IDs alone', async () => {
	const f = await couponExecutorFixture()
	f.state.failDomain = true
	await Effect.runPromise(f.executor.execute(f.request))
	f.state.failDomain = false
	f.state.receipt = { ...f.state.receipt!, providerReceiptId: 'wrong-receipt' }
	const result = await Effect.runPromise(
		f.executor.recoverRecordedPage({ now: new Date(f.getNow()), limit: 1 }),
	)
	expect(result.results[0]?.type).toBe('Held')
	expect(f.state.mutations).toBe(1)
})

it('holds a conflicting binding owner instead of rebinding', async () => {
	const f = await couponExecutorFixture()
	const bind = await f.prepareBinding()
	f.state.failDomain = true
	await Effect.runPromise(
		f.executor.execute({
			journeyId: bind.journeyId,
			idempotencyKey: bind.idempotencyKey,
		}),
	)
	f.state.failDomain = false
	f.state.receipt = {
		...f.state.receipt!,
		coupon: {
			...f.state.receipt!.coupon,
			binding: { type: 'AwaitingVerifiedUser' },
		},
	}
	const result = await Effect.runPromise(
		f.executor.recoverRecordedPage({ now: new Date(f.getNow()), limit: 10 }),
	)
	expect(result.results.at(-1)?.type).toBe('Held')
	expect(f.state.mutations).toBe(2)
})
