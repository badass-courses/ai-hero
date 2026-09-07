import { Effect, Either } from 'effect'
import { expect, it, vi } from 'vitest'
import { createDrizzleJourneyAttempts } from './drizzle-attempts'
import type { EvergreenOfferJourneyDatabase } from './drizzle-ledger'

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
})
