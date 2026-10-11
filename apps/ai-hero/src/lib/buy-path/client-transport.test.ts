import { afterEach, expect, it, vi } from 'vitest'
import { createBuyPathLogger } from './client'
afterEach(() => {
	vi.unstubAllGlobals()
})
it('consumes rejecting async transports without throwing or returning a rejection', async () => {
	const emit = createBuyPathLogger('cs_test_fixture', async () => {
		throw new Error('offline')
	})
	expect(emit('pricing_viewed')).toBeUndefined()
	await new Promise((resolve) => setTimeout(resolve, 0))
})
it.each(['reject', 'throw', '403'] as const)(
	'silently ignores fetch %s after beacon refusal',
	async (mode) => {
		vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) })
		const fetch = vi.fn(() => {
			if (mode === 'throw') throw new Error('blocked')
			return mode === 'reject'
				? Promise.reject(new Error('offline'))
				: Promise.resolve(new Response(null, { status: 403 }))
		})
		vi.stubGlobal('fetch', fetch)
		expect(
			createBuyPathLogger('cs_test_fixture')('pricing_viewed'),
		).toBeUndefined()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(fetch).toHaveBeenCalledOnce()
	},
)
it('falls back safely when beacon throws and fetch rejects', async () => {
	vi.stubGlobal('navigator', {
		sendBeacon: () => {
			throw new Error('blocked')
		},
	})
	const fetch = vi.fn(() => Promise.reject(new Error('offline')))
	vi.stubGlobal('fetch', fetch)
	expect(
		createBuyPathLogger('cs_test_fixture')('pricing_viewed'),
	).toBeUndefined()
	await new Promise((resolve) => setTimeout(resolve, 0))
	expect(fetch).toHaveBeenCalledOnce()
})
