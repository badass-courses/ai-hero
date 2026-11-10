import { randomUUID } from 'node:crypto'
import { Redis } from '@upstash/redis'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createEarlyAccessLock } from './early-access-lock'

// Point these test-only variables at throwaway Redis behind SRH, never prod.
// Uses the unchanged @upstash/redis HTTP client and production lease function.
const url = process.env.AIH_TEST_REDIS_REST_URL
const token = process.env.AIH_TEST_REDIS_REST_TOKEN
if (url && !['localhost', '127.0.0.1'].includes(new URL(url).hostname))
	throw new Error('Redis lease integration tests require a loopback fixture')
const redis = url && token ? new Redis({ url, token }) : null!
const ids = Array.from({ length: 3 }, () => `in_lock_test_${randomUUID()}`)
const key = (id: string) => `aih:early-access:lock:${id}`

describe.skipIf(!redis)(
	'real Redis lease through Upstash REST protocol',
	() => {
		afterAll(async () => {
			await redis.del(...ids.map(key))
		})

		it('allows one concurrent winner, then releases for the next operation', async () => {
			const lock = createEarlyAccessLock(redis)
			let entered!: () => void, finish!: () => void
			const held = new Promise<void>((resolve) => {
				entered = resolve
			})
			const gate = new Promise<void>((resolve) => {
				finish = resolve
			})
			const first = lock(ids[0]!, async () => {
				entered()
				await gate
				return 'winner'
			})
			await held
			try {
				expect(await redis.pttl(key(ids[0]!))).toBeGreaterThan(0)
				const contender = vi.fn()
				await expect(lock(ids[0]!, contender)).rejects.toThrow(
					'Another early-access',
				)
				expect(contender).not.toHaveBeenCalled()
			} finally {
				finish()
			}
			expect(await first).toBe('winner')
			expect(await lock(ids[0]!, async () => 'next')).toBe('next')
			expect(await redis.exists(key(ids[0]!))).toBe(0)
		})

		it('a stale holder cannot release a successor token', async () => {
			const lock = createEarlyAccessLock(redis)
			await expect(
				lock(ids[1]!, async () => {
					await redis.set(key(ids[1]!), 'successor-token', { px: 60_000 })
				}),
			).rejects.toThrow('lease expired or changed')
			expect(await redis.get(key(ids[1]!))).toBe('successor-token')
		})

		it('expiry frees an abandoned holder', async () => {
			// Shorten only this abandoned synthetic lease; prod TTL is tested as 60s.
			await redis.set(key(ids[2]!), 'crashed-holder', { nx: true, px: 250 })
			const lock = createEarlyAccessLock(redis)
			await expect(lock(ids[2]!, async () => 'blocked')).rejects.toThrow(
				'Another early-access',
			)
			await vi.waitFor(
				async () => {
					expect(await redis.exists(key(ids[2]!))).toBe(0)
				},
				{ timeout: 2000, interval: 25 },
			)
			expect(await lock(ids[2]!, async () => 'recovered')).toBe('recovered')
		})
	},
)
