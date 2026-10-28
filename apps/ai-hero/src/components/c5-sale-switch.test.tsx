import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const switchState = vi.hoisted(() => ({ closed: false }))
vi.mock('@/lib/c5-pricing/switch-server', () => ({
	c5PricingClosed: vi.fn(async () => switchState.closed),
}))

import { C5SaleSwitch } from './c5-sale-switch'

afterEach(() => {
	vi.useRealTimers()
	switchState.closed = false
})

async function markup() {
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			{await C5SaleSwitch({
				children: <a href="/s/c5-site-cta">C5 enrollment</a>,
				fallback: <a href="/s/crash-course">Existing offer</a>,
			})}
		</QueryClientProvider>,
	)
}

describe('server C5 sale switch', () => {
	it.each([
		['2026-10-25T18:58:59.999Z', false],
		['2026-10-25T18:59:00.000Z', true],
		['2026-11-10T07:59:59.000Z', false],
	])('renders the right first paint at %s', async (instant, active) => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(instant))
		expect(await markup()).toContain(
			active ? 'C5 enrollment' : 'Existing offer',
		)
	})

	it('renders the existing offer when the flag or env has closed pricing', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'))
		switchState.closed = true
		expect(await markup()).toContain('Existing offer')
		expect(await markup()).not.toContain('C5 enrollment')
	})
})
