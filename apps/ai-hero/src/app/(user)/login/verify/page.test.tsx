import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	cookies: vi.fn(),
}))

vi.mock('next/headers', () => ({ cookies: mocks.cookies }))
vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: ReactNode }) => children,
}))

import {
	MAGIC_LINK_COOKIE_NAME,
	createMagicLinkGetHandler,
} from '@/server/magic-link-confirmation'

import VerifyMagicLinkPage from './page'

const secret = 'test_nextauth_secret'

async function validCookie() {
	const response = await createMagicLinkGetHandler(vi.fn(), {
		secret,
		now: Date.now(),
	})(
		new Request(
			'https://www.aihero.dev/api/auth/callback/postmark?callbackUrl=https%3A%2F%2Fwww.aihero.dev%2Fwelcome&token=one-time-token&email=learner%40example.com',
		),
	)
	const pair = response.headers.get('set-cookie')!.split(';', 1)[0]!
	return pair.slice(pair.indexOf('=') + 1)
}

describe('magic-link confirmation page', () => {
	beforeEach(() => {
		mocks.cookies.mockResolvedValue({ get: vi.fn(() => undefined) })
	})

	it('renders only a query-free confirm action for a valid cookie', async () => {
		const value = await validCookie()
		mocks.cookies.mockResolvedValue({
			get: vi.fn((name: string) =>
				name === MAGIC_LINK_COOKIE_NAME ? { value } : undefined,
			),
		})

		const markup = renderToStaticMarkup(await VerifyMagicLinkPage())

		expect(markup).toContain('action="/api/auth/magic-link/confirm"')
		expect(markup).not.toContain('one-time-token')
		expect(markup).not.toContain('learner@example.com')
	})

	it('renders an expired state when the cookie is missing', async () => {
		const markup = renderToStaticMarkup(await VerifyMagicLinkPage())

		expect(markup).toContain('This login link expired')
		expect(markup).not.toContain('<form')
	})
})
