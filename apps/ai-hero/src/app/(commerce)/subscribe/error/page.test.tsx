import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
}))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.test' },
}))

import SubscribeErrorPage from './page'

const render = async (searchParams: Record<string, string>) =>
	renderToStaticMarkup(
		await SubscribeErrorPage({ searchParams: Promise.resolve(searchParams) }),
	)

const FALLBACK = 'This link may have expired'

describe('/subscribe/error', () => {
	it.each([
		['purchase-blocked', "We can&#x27;t complete this purchase"],
		['regional-team-not-allowed', 'Regional pricing is for one seat'],
		['regional-upgrade', 'You already have a regional ticket'],
		['browser-mismatch', 'One more step'],
		['invalid-expired', 'This checkout link has expired'],
		['invalid-quantity', 'number of seats'],
		['checkout-unavailable', 'start checkout'],
	])('renders the copy for %s', async (reason, text) => {
		const html = await render({ reason })
		expect(html).toContain(text)
		expect(html).not.toContain(FALLBACK)
		expect(html).not.toContain('Send me a new link')
	})

	it('renders the fallback with the resend path when there is no reason', async () => {
		const html = await render({})
		expect(html).toContain(FALLBACK)
		expect(html).toContain('href="/login"')
		expect(html).toContain('Send me a new link')
	})

	it('renders the fallback for an unknown reason', async () => {
		const html = await render({ reason: 'nope' })
		expect(html).toContain(FALLBACK)
		expect(html).toContain('href="/login"')
	})
})
