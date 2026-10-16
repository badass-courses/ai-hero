import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }))
vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.useQuery }))
import { EvergreenOfferCard } from './evergreen-offer-card'

describe('evergreen offer admin card', () => {
	it('shows a neutral loading state and pending conversion, not zero', () => {
		mocks.useQuery.mockReturnValue({ isPending: true })
		const html = renderToStaticMarkup(<EvergreenOfferCard range="7d" />)
		expect(html).toContain('Loading evergreen revenue…')
		expect(html).toContain('Conversion: pending')
		expect(html).not.toContain('0%')
	})
	it('shows USD net and purchase count for the picked range', () => {
		mocks.useQuery.mockReturnValue({
			data: {
				currency: 'USD',
				byKind: [{ kind: 'evergreen', net: 62.25, purchaseCount: 4 }],
			},
		})
		const html = renderToStaticMarkup(<EvergreenOfferCard range="90d" />)
		expect(html).toContain('$62.25 net · 4 purchases (incl. refunded)')
		expect(mocks.useQuery.mock.calls.at(-1)?.[0].queryKey).toEqual([
			'analytics',
			'revenue/promos',
			'90d',
		])
		expect(html).toContain('Conversion: pending')
	})
	it('asks for a bounded range without fetching all history', () => {
		mocks.useQuery.mockReturnValue({ isPending: true })
		const html = renderToStaticMarkup(<EvergreenOfferCard range="all" />)
		expect(html).toContain('Choose a bounded range')
		expect(mocks.useQuery.mock.calls.at(-1)?.[0].enabled).toBe(false)
	})

	it('uses an unavailable state rather than fabricating zero', () => {
		mocks.useQuery.mockReturnValue({ isError: true })
		const html = renderToStaticMarkup(<EvergreenOfferCard range="30d" />)
		expect(html).toContain('temporarily unavailable')
		expect(html).not.toContain('$0')
	})
	it('forwards the query cancellation signal and selected range', async () => {
		mocks.useQuery.mockReturnValue({ isPending: true })
		renderToStaticMarkup(<EvergreenOfferCard range="24h" />)
		const fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, data: { currency: 'USD' } }),
		})
		vi.stubGlobal('fetch', fetch)
		try {
			const signal = new AbortController().signal
			await mocks.useQuery.mock.calls.at(-1)?.[0].queryFn({ signal })
			expect(fetch).toHaveBeenCalledWith(
				'/api/analytics?surface=revenue%2Fpromos&range=24h',
				{ signal, cache: 'no-store' },
			)
		} finally {
			vi.unstubAllGlobals()
		}
	})
})
