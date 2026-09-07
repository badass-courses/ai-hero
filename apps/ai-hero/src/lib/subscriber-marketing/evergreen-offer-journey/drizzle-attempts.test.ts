import { Effect, Either } from 'effect'
import type { SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { expect, it, vi } from 'vitest'
import { createDrizzleJourneyAttempts } from './drizzle-attempts'
import { decodeAttempt } from './attempt-evidence'
import type { EvergreenOfferJourneyDatabase } from './drizzle-ledger'

it('requires a bounded observation on new refusals and never rewrites the first observation', async () => {
	const identity = {
		idempotencyKey: 'intent-observed',
		journeyId: 'journey-observed',
		claimToken: 'dcbf2377-2c3f-4b12-b67e-a732352f17ad',
	}
	let stored = decodeAttempt({
		...identity,
		format: 'evergreen-offer-journey.attempt.v1',
		status: 'Claimed',
		claimedAt: new Date('2026-09-04T17:00:00.000Z'),
		leaseExpiresAt: new Date('2026-09-04T17:01:00.000Z'),
		outcome: null,
	})
	const update = vi.fn(() => ({
		set: (patch: unknown) => ({
			where: async () => {
				stored = decodeAttempt({ ...stored, ...(patch as object) })
			},
		}),
	}))
	const tx = {
		execute: async () => [],
		query: { evergreenOfferJourneyAttempt: { findFirst: async () => stored } },
		update,
	}
	const repository = createDrizzleJourneyAttempts({
		transaction: async (work: (tx: unknown) => Promise<unknown>) => work(tx),
	} as unknown as EvergreenOfferJourneyDatabase)
	const now = new Date('2026-09-04T17:00:00.500Z')
	for (const observedAt of [
		undefined,
		'bad',
		'2026-09-04T16:59:59.999Z',
		'2026-09-04T17:00:00.501Z',
	]) {
		const result = await Effect.runPromise(
			Effect.either(
				repository.settle({
					...identity,
					now,
					outcome: {
						type: 'KnownNotApplied',
						reason: 'ProviderRefused',
						...(observedAt === undefined ? {} : { observedAt }),
					},
				}),
			),
		)
		expect(Either.isLeft(result)).toBe(true)
	}
	expect(update).not.toHaveBeenCalled()
	const outcome = {
		type: 'KnownNotApplied' as const,
		reason: 'ProviderRefused' as const,
		observedAt: now.toISOString(),
	}
	const first = await Effect.runPromise(
		repository.settle({ ...identity, now, outcome }),
	)
	expect(first.outcome).toEqual(outcome)
	expect(
		await Effect.runPromise(
			repository.settle({ ...identity, now: new Date('2027-01-01'), outcome }),
		),
	).toEqual(first)
	for (const changed of [
		{ ...outcome, observedAt: '2026-09-04T17:00:00.499Z' },
		{ type: 'KnownNotApplied' as const, reason: 'ProviderRefused' as const },
	]) {
		expect(
			Either.isLeft(
				await Effect.runPromise(
					Effect.either(
						repository.settle({ ...identity, now, outcome: changed }),
					),
				),
			),
		).toBe(true)
	}
	expect(update).toHaveBeenCalledOnce()
	expect(stored).toEqual(first)
})

it.each([
	{ type: 'HeldUncertain', reason: 'Cancelled' },
	{ type: 'KnownNotApplied', reason: 'ProviderRefused' },
] as const)(
	'returns exact recorded $type evidence after expiry without writes',
	async (outcome) => {
		const identity = {
			idempotencyKey: 'intent-one',
			journeyId: 'journey-one',
			claimToken: 'dcbf2377-2c3f-4b12-b67e-a732352f17ad',
		}
		const row = {
			...identity,
			format: 'evergreen-offer-journey.attempt.v1',
			status: outcome.type,
			claimedAt: new Date('2026-09-04T17:00:00Z'),
			leaseExpiresAt: new Date('2026-09-04T17:01:00Z'),
			outcome,
		}
		const update = vi.fn(() => {
			throw new Error('Unexpected write')
		})
		const tx = {
			execute: vi.fn(async () => []),
			query: {
				evergreenOfferJourneyAttempt: { findFirst: vi.fn(async () => row) },
			},
			update,
		}
		const database = {
			transaction: async (work: (transaction: typeof tx) => Promise<unknown>) =>
				work(tx),
		} as unknown as EvergreenOfferJourneyDatabase
		const repository = createDrizzleJourneyAttempts(database)
		const request = {
			...identity,
			outcome,
			now: new Date('2026-09-04T17:02:00Z'),
		}
		expect(await Effect.runPromise(repository.settle(request))).toEqual(row)
		const wrongToken = await Effect.runPromise(
			Effect.either(
				repository.settle({
					...request,
					claimToken: 'dcbf2377-2c3f-4b12-b67e-a732352f17ae',
				}),
			),
		)
		expect(Either.isLeft(wrongToken) && wrongToken.left.type).toBe(
			'AttemptRefused',
		)
		const conflict = await Effect.runPromise(
			Effect.either(
				repository.settle({
					...request,
					outcome: { type: 'HeldUncertain', reason: 'Unknown' },
				}),
			),
		)
		expect(Either.isLeft(conflict) && conflict.left.type).toBe('AttemptRefused')
		expect(update).not.toHaveBeenCalled()
	},
)

it.each(['recoveryPage', 'recordedOutcomeRecoveryPage'] as const)(
	'%s validates cursor and page bounds before database access',
	async (method) => {
		const select = vi.fn()
		const transaction = vi.fn()
		const repository = createDrizzleJourneyAttempts({
			select,
			transaction,
		} as unknown as EvergreenOfferJourneyDatabase)
		const cursor = {
			leaseExpiresAt: '2026-09-04T17:01:00.000Z',
			idempotencyKey: 'intent-one',
		}
		const valid =
			method === 'recordedOutcomeRecoveryPage'
				? { ...cursor, status: 'Accepted' }
				: cursor
		for (const after of [
			null,
			{},
			{ ...valid, leaseExpiresAt: 'invalid' },
			{ ...valid, leaseExpiresAt: '2026-09-04T17:01:00Z' },
			{ ...valid, idempotencyKey: ' bad ' },
			{ ...valid, idempotencyKey: '*' },
			{ ...valid, extra: true },
			{ ...valid, status: 'Unknown' },
		]) {
			const input = {
				now: new Date(),
				limit: 1,
				after,
			} as unknown as Parameters<
				typeof repository.recordedOutcomeRecoveryPage
			>[0]
			const result =
				method === 'recoveryPage'
					? await Effect.runPromise(
							Effect.either(repository.recoveryPage(input)),
						)
					: await Effect.runPromise(
							Effect.either(repository.recordedOutcomeRecoveryPage(input)),
						)
			expect(result._tag === 'Left' && result.left.type).toBe('AttemptRefused')
		}
		for (const limit of [0, 101, 1.1]) {
			const result =
				method === 'recoveryPage'
					? await Effect.runPromise(
							Effect.either(
								repository.recoveryPage({ now: new Date(), limit }),
							),
						)
					: await Effect.runPromise(
							Effect.either(
								repository.recordedOutcomeRecoveryPage({
									now: new Date(),
									limit,
								}),
							),
						)
			expect(result._tag).toBe('Left')
		}
		expect(select).not.toHaveBeenCalled()
		expect(transaction).not.toHaveBeenCalled()
	},
)

it('empty pages preserve continuation and array compatibility without extra queries', async () => {
	const limit = vi.fn(async () => [])
	const where = () => ({ orderBy: () => ({ limit }) })
	const tx = {
		select: () => ({ from: () => ({ where, innerJoin: () => ({ where }) }) }),
	}
	const repository = createDrizzleJourneyAttempts({
		...tx,
		transaction: async (work: (tx: unknown) => Promise<unknown>) => work(tx),
	} as unknown as EvergreenOfferJourneyDatabase)
	const input = { now: new Date(), limit: 2 }
	const cursor = {
		leaseExpiresAt: '2026-09-04T17:01:00.000Z',
		idempotencyKey: 'intent-one',
	}
	expect(
		await Effect.runPromise(
			repository.recoveryPage({ ...input, after: cursor }),
		),
	).toEqual({ candidates: [], scanned: 0, end: true, nextCursor: cursor })
	const recorded = { ...cursor, status: 'Accepted' as const }
	expect(
		await Effect.runPromise(
			repository.recordedOutcomeRecoveryPage({ ...input, after: recorded }),
		),
	).toEqual({ candidates: [], scanned: 0, end: true, nextCursor: recorded })
	expect(await Effect.runPromise(repository.recoveryPage(input))).toMatchObject(
		{ nextCursor: null, end: true },
	)
	expect(
		await Effect.runPromise(repository.recordedOutcomeRecoveryPage(input)),
	).toMatchObject({ nextCursor: null, end: true })
	expect(await Effect.runPromise(repository.recovery(input))).toEqual([])
	expect(
		await Effect.runPromise(repository.recordedOutcomeRecovery(input)),
	).toEqual([])
	expect(limit).toHaveBeenCalledTimes(6)
})

it('parameterizes continuation in the exact per-method SQL sort order', async () => {
	const dialect = new MySqlDialect()
	const orders: string[][] = []
	const predicates: ReturnType<typeof dialect.sqlToQuery>[] = []
	const where = (condition: SQL) => {
		predicates.push(dialect.sqlToQuery(condition))
		return {
			orderBy: (...columns: SQL[]) => {
				orders.push(columns.map((column) => dialect.sqlToQuery(column).sql))
				return { limit: async () => [] }
			},
		}
	}
	const tx = {
		select: () => ({ from: () => ({ where, innerJoin: () => ({ where }) }) }),
	}
	const repository = createDrizzleJourneyAttempts({
		...tx,
		transaction: async (work: (tx: unknown) => Promise<unknown>) => work(tx),
	} as unknown as EvergreenOfferJourneyDatabase)
	const after = {
		leaseExpiresAt: '2026-09-04T17:01:00.000Z',
		idempotencyKey: "intent-'quoted",
	}
	await Effect.runPromise(
		repository.recoveryPage({ now: new Date(), limit: 2, after }),
	)
	await Effect.runPromise(
		repository.recordedOutcomeRecoveryPage({
			now: new Date(),
			limit: 2,
			after: { ...after, status: 'Accepted' },
		}),
	)
	expect(orders[0]?.map((part) => part.split('.').at(-1))).toEqual([
		'`leaseExpiresAt` asc',
		'`idempotencyKey` asc',
	])
	expect(orders[1]?.map((part) => part.split('.').at(-1))).toEqual([
		'`status` asc',
		'`leaseExpiresAt` asc',
		'`idempotencyKey` asc',
	])
	for (const query of predicates) {
		expect(query.sql).not.toContain(after.idempotencyKey)
		expect(query.params).toContain(after.idempotencyKey)
		expect(query.sql).toContain('`leaseExpiresAt` > ?')
		expect(query.sql).toContain('`leaseExpiresAt` = ?')
		expect(query.sql).toContain('`idempotencyKey` > ?')
		expect(query.sql).not.toMatch(/offset/i)
	}
	expect(predicates[0]?.sql).not.toContain('`status` > ?')
	expect(predicates[1]?.sql).toContain('`status` > ?')
})

it('reads uncertain recovery in one statement, without a second-select duplicate race', async () => {
	const row = {
		format: 'evergreen-offer-journey.attempt.v1',
		idempotencyKey: 'intent-one',
		journeyId: 'journey-one',
		claimToken: 'dcbf2377-2c3f-4b12-b67e-a732352f17ad',
		status: 'Claimed',
		claimedAt: new Date('2026-09-04T17:00:00Z'),
		leaseExpiresAt: new Date('2026-09-04T17:01:00Z'),
		outcome: null,
	}
	const limit = vi.fn(async () => [{ ...row }])
	const select = vi.fn(() => ({
		from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }),
	}))
	// Controlled query seam: a second select could see this same key after a
	// concurrent status change. A single statement cannot duplicate its PK.
	const repository = createDrizzleJourneyAttempts({
		select,
	} as unknown as EvergreenOfferJourneyDatabase)
	const result = await Effect.runPromise(
		repository.recovery({ now: row.leaseExpiresAt, limit: 10 }),
	)
	expect(select).toHaveBeenCalledTimes(1)
	expect(result).toHaveLength(1)
	expect(result[0]?.evidence.idempotencyKey).toBe(row.idempotencyKey)
	const page = await Effect.runPromise(
		repository.recoveryPage({ now: row.leaseExpiresAt, limit: 1 }),
	)
	expect(page).toEqual({
		candidates: result,
		scanned: 1,
		end: false,
		nextCursor: {
			leaseExpiresAt: row.leaseExpiresAt.toISOString(),
			idempotencyKey: row.idempotencyKey,
		},
	})
})
