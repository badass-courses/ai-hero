// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { C5SaleClientSwitch } from './c5-sale-client-switch'

let root: Root
let container: HTMLDivElement
let client: QueryClient

afterEach(async () => {
	await act(async () => root?.unmount())
	client?.clear()
	container?.remove()
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

async function mount(pricingClosed: boolean, liveClosed: boolean | null) {
	;(
		globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'))
	const fetchStatus = vi.fn(async () => {
		if (liveClosed === null) throw new Error('Read unavailable')
		return Response.json({ pricingClosed: liveClosed })
	})
	vi.stubGlobal('fetch', fetchStatus)
	container = document.createElement('div')
	document.body.appendChild(container)
	root = createRoot(container)
	client = new QueryClient()
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				{[1, 2].map((key) => (
					<C5SaleClientSwitch
						key={key}
						pricingClosed={pricingClosed}
						initialFeaturedActive
						fallback={<span>Existing offer</span>}
					>
						<span>C5 enrollment</span>
					</C5SaleClientSwitch>
				))}
			</QueryClientProvider>,
		)
	})
	// Flush React Query's batched observer notifications.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10))
	})
	return fetchStatus
}

describe('cached server promotions', () => {
	it('falls back if the fresh switch read fails', async () => {
		await mount(false, null)
		expect(container.textContent).toBe('Existing offerExisting offer')
	})

	it('closes stale static markup after a fresh flag read, deduplicated across surfaces', async () => {
		const fetchStatus = await mount(false, true)
		expect(container.textContent).toBe('Existing offerExisting offer')
		expect(fetchStatus).toHaveBeenCalledTimes(1)
		expect(fetchStatus).toHaveBeenCalledWith('/api/c5-site-promo', {
			cache: 'no-store',
		})
	})

	it('opens a cached disabled surface when the flag has since opened', async () => {
		await mount(true, false)
		expect(container.textContent).toBe('C5 enrollmentC5 enrollment')
	})
})
