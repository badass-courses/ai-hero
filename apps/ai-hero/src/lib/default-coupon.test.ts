import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CouponPort } from '@coursebuilder/core/ports'

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	cache: new Map<string, unknown>(),
	tag: vi.fn(),
	warn: vi.fn(),
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: { getDefaultCoupon: mocks.read },
}))
vi.mock('@/server/logger', () => ({ log: { warn: mocks.warn } }))
vi.mock('next/cache', () => ({
	unstable_cache: (fn: () => Promise<unknown>, keys: string[]) => async () => {
		const key = JSON.stringify(keys)
		if (!mocks.cache.has(key))
			mocks.cache.set(key, JSON.parse(JSON.stringify(await fn())))
		return mocks.cache.get(key)
	},
	revalidateTag: (...args: unknown[]) => {
		mocks.tag(...args)
		mocks.cache.clear()
	},
}))

import { getCachedDefaultCoupon } from './default-coupon'
import {
	invalidateDefaultCoupon,
	withDefaultCouponInvalidation,
} from './default-coupon-invalidation'

const sale = (expires = new Date(Date.now() + 60_000)) => ({
	defaultMerchantCoupon: { id: 'merchant' },
	defaultCoupon: { id: 'coupon', createdAt: new Date('2026-01-01'), expires },
})

beforeEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
	mocks.cache.clear()
	mocks.read.mockResolvedValue(sale())
	mocks.warn.mockResolvedValue(undefined)
})

describe('display-only default coupon cache', () => {
	it('hits the cache and restores serialized dates', async () => {
		const result = await getCachedDefaultCoupon(['a'])
		expect(result?.defaultCoupon.expires).toBeInstanceOf(Date)
		expect(result?.defaultCoupon.createdAt).toBeInstanceOf(Date)
		expect(await getCachedDefaultCoupon(['a'])).toEqual(result)
		expect(mocks.read).toHaveBeenCalledTimes(1)
	})
	it('normalizes product sets but isolates distinct products and undefined from []', async () => {
		await getCachedDefaultCoupon(['b', 'a', 'a'])
		await getCachedDefaultCoupon(['a', 'b'])
		await getCachedDefaultCoupon(['c'])
		await getCachedDefaultCoupon()
		await getCachedDefaultCoupon([])
		expect(mocks.read.mock.calls).toEqual([
			[['a', 'b']],
			[['c']],
			[undefined],
			[[]],
		])
	})
	it('caches misses', async () => {
		mocks.read.mockResolvedValue(null)
		expect(await getCachedDefaultCoupon(['a'])).toBeNull()
		expect(await getCachedDefaultCoupon(['a'])).toBeNull()
		expect(mocks.read).toHaveBeenCalledTimes(1)
	})
	it('falls back fresh at the hard TTL even if Next returns a stale entry', async () => {
		vi.useFakeTimers()
		await getCachedDefaultCoupon(['a'])
		mocks.read.mockResolvedValue(null)
		vi.advanceTimersByTime(30_000)
		expect(await getCachedDefaultCoupon(['a'])).toBeNull()
		expect(mocks.read).toHaveBeenCalledTimes(2)
	})
	it('stops displaying an expired coupon immediately, without waiting for the TTL', async () => {
		vi.useFakeTimers()
		mocks.read.mockResolvedValue(sale(new Date(Date.now() + 1000)))
		await getCachedDefaultCoupon(['a'])
		mocks.read.mockResolvedValue(null)
		vi.advanceTimersByTime(1000)
		expect(await getCachedDefaultCoupon(['a'])).toBeNull()
	})
	it('revalidates after coupon creation and leaves payment-time reads untouched', async () => {
		await getCachedDefaultCoupon(['a'])
		const result = { id: 'new-coupon' }
		const original = {
			createCoupon: vi.fn(async () => result),
			getDefaultCoupon: mocks.read,
		}
		const adapter = withDefaultCouponInvalidation(
			original as unknown as CouponPort,
		)
		expect(adapter.getDefaultCoupon).toBe(original.getDefaultCoupon)
		expect(await adapter.createCoupon({} as never)).toBe(result)
		expect(mocks.tag).toHaveBeenCalledWith('default-coupon', { expire: 0 })
		mocks.read.mockResolvedValue(null)
		expect(await getCachedDefaultCoupon(['a'])).toBeNull()
	})
})

describe('fail-open coupon invalidation', () => {
	it('preserves result identity and arguments, and invalidates only after a successful write', async () => {
		const result = { id: 'coupon' }
		const createCoupon = vi.fn(async () => result)
		const invalidate = vi.fn(async () => {})
		const adapter = withDefaultCouponInvalidation(
			{ createCoupon } as unknown as CouponPort,
			invalidate,
		)
		const input = {} as never
		expect(await adapter.createCoupon(input)).toBe(result)
		expect(createCoupon).toHaveBeenCalledWith(input)
		expect(createCoupon.mock.invocationCallOrder[0]).toBeLessThan(
			invalidate.mock.invocationCallOrder[0]!,
		)
		invalidate.mockRejectedValueOnce(new Error('invalidation failed'))
		mocks.warn.mockRejectedValueOnce(new Error('logging failed'))
		expect(await adapter.createCoupon(input)).toBe(result)
		createCoupon.mockRejectedValueOnce(new Error('write failed'))
		await expect(adapter.createCoupon(input)).rejects.toThrow('write failed')
		expect(invalidate).toHaveBeenCalledTimes(2)
	})
	it('does not reject when tag revalidation fails', async () => {
		mocks.tag.mockImplementationOnce(() => {
			throw new Error('cache unavailable')
		})
		await expect(invalidateDefaultCoupon()).resolves.toBeUndefined()
		expect(mocks.warn).toHaveBeenCalledWith(
			'default_coupon.invalidation_failed',
		)
	})
})
