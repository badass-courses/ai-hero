import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/app/(email-list)/_components/email', () => ({
	Email: () => <>learner@example.com</>,
}))
vi.mock('@/app/(email-list)/_components/signature', () => ({
	Signature: () => <>Matt</>,
}))
vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
}))
vi.mock('@/env.mjs', () => ({
	env: { DROVR_API_BASE_URL: 'https://drovr.test' },
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import ConfirmSubscriptionPage from './page'

const token = 'v1.eyJjIjoiYyJ9.c2lnbmF0dXJl'
let fetcher: ReturnType<
	typeof vi.fn<[string | URL | Request, RequestInit?], Promise<Response>>
>

const stateIs = (status: string) => {
	fetcher.mockImplementation(async () =>
		Response.json({
			status,
			formId: 'skills-newsletter',
			tenantId: 'org-aihero',
		}),
	)
}
const render = async (searchParams: Record<string, string>) =>
	renderToStaticMarkup(
		await ConfirmSubscriptionPage({
			searchParams: Promise.resolve(searchParams),
		}),
	)

beforeEach(() => {
	fetcher = vi.fn<[string | URL | Request, RequestInit?], Promise<Response>>()
	vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
	vi.unstubAllGlobals()
})

describe('/confirm?t= (drovr double opt-in): opening the link confirms nothing', () => {
	it('reads the state with one GET and renders a Confirm button that POSTs', async () => {
		stateIs('awaiting')
		const markup = await render({ t: token })

		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			`https://drovr.test/confirm/state?t=${encodeURIComponent(token)}`,
		)
		expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET')
		expect(markup).toContain('data-doi-confirm="awaiting"')
		expect(markup).toMatch(
			/<form[^>]*action="\/confirm\/submit"[^>]*method="post"/,
		)
		expect(markup).toMatch(/<input[^>]*name="t"[^>]*value="v1\./)
		expect(markup).toMatch(/<input[^>]*name="action"[^>]*value="confirm"/)
	})

	it('never POSTs to drovr from a GET, whatever the result param says', async () => {
		for (const status of ['awaiting', 'expired', 'confirmed', 'suppressed']) {
			stateIs(status)
			await render({ t: token, result: 'confirmed' })
		}
		for (const [, init] of fetcher.mock.calls) {
			expect(init?.method).toBe('GET')
		}
	})

	it('offers a new link on expiry, and stays neutral when suppressed', async () => {
		stateIs('expired')
		const expired = await render({ t: token })
		expect(expired).toContain('This link has expired')
		expect(expired).toMatch(/<input[^>]*name="action"[^>]*value="resend"/)

		stateIs('suppressed')
		const suppressed = await render({ t: token })
		expect(suppressed).toContain('subscribe this address')
		expect(suppressed).not.toContain('<form')
	})

	it('says you are in only after a confirmed POST', async () => {
		stateIs('confirmed')
		expect(await render({ t: token, result: 'confirmed' })).toContain(
			'Your first lesson is on its way',
		)
		expect(await render({ t: token })).toContain('already confirmed')
	})

	it('keeps the plain check-your-inbox page when there is no token', async () => {
		const markup = await render({})
		expect(fetcher).not.toHaveBeenCalled()
		expect(markup).toContain('Confirm your email address')
		expect(markup).not.toContain('data-doi-confirm')
	})
})
