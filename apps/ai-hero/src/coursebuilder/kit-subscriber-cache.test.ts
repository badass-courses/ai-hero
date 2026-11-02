import { describe, expect, it, vi } from 'vitest'
import { createKitSubscriberCache } from './kit-subscriber-cache'

describe('Kit subscriber ID cache', () => {
	it('caches successful reads by id for three minutes, preserving opt-out state', async () => {
		let now = 0
		const subscriber = {
			id: 42,
			state: 'cancelled',
			fields: { aih_email_opt_out: 'true' },
		}
		const load = vi.fn().mockResolvedValue(subscriber)
		const cache = createKitSubscriberCache<typeof subscriber>(load, {
			now: () => now,
		})
		const first = await cache.get('42')
		expect(await cache.get('42')).toEqual(subscriber)
		expect(load).toHaveBeenCalledOnce()
		first!.state = 'active'
		expect(await cache.get('42')).toEqual(subscriber)
		await cache.get('43')
		expect(load).toHaveBeenCalledTimes(2)
		now = 180_000
		await cache.get('42')
		expect(load).toHaveBeenCalledTimes(3)
	})
	it.each([429, 500, 401])(
		'never caches HTTP %s as absence',
		async (status) => {
			const load = vi
				.fn()
				.mockRejectedValueOnce(Object.assign(new Error('refused'), { status }))
				.mockResolvedValue({ id: 42 })
			const cache = createKitSubscriberCache(load)
			await expect(cache.get('42')).rejects.toMatchObject({ status })
			expect(await cache.get('42')).toEqual({ id: 42 })
			expect(load).toHaveBeenCalledTimes(2)
		},
	)
	it('caches verified 404, but not ambiguous empty responses', async () => {
		const load = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValue(null)
		const cache = createKitSubscriberCache(load)
		await cache.get('42')
		await cache.get('42')
		await cache.get('42')
		expect(load).toHaveBeenCalledTimes(2)
	})
	it('deduplicates concurrent requests and invalidates after writes', async () => {
		const load = vi.fn().mockResolvedValue({ id: 42 })
		const cache = createKitSubscriberCache(load)
		await Promise.all([cache.get('42'), cache.get('42')])
		expect(load).toHaveBeenCalledOnce()
		cache.invalidate('42')
		await cache.get('42')
		expect(load).toHaveBeenCalledTimes(2)
	})
	it('bounds the number of retained subscribers', async () => {
		const load = vi.fn().mockResolvedValue({ id: 42 })
		const cache = createKitSubscriberCache(load, { maxEntries: 1 })
		await cache.get('42')
		await cache.get('43')
		await cache.get('42')
		expect(load).toHaveBeenCalledTimes(3)
	})
})
