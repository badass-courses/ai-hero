import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	searchParams: new URLSearchParams(),
}))

vi.mock('next/navigation', () => ({
	useSearchParams: () => mocks.searchParams,
}))

vi.mock('next-auth/react', () => ({
	signIn: vi.fn(),
}))

vi.mock('@/components/brand/icons', () => ({
	Icon: () => null,
}))

vi.mock('@/components/landing/hero-shader', () => ({
	HeroShader: () => null,
}))

vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.com' },
}))

import { getLoginErrorInfo, getLoginMessageInfo, Login } from './login'

describe('Login error copy', () => {
	beforeEach(() => {
		mocks.searchParams = new URLSearchParams()
	})

	it.each([
		[
			'OAuthCallbackError',
			"Sign-in couldn't be completed",
			'Try GitHub or Discord again',
		],
		[
			'OAuthAccountNotLinked',
			'Account not connected',
			'Sign in with email first',
		],
		['AccountNotLinked', 'Account not connected', 'Sign in with email first'],
		['MissingCSRF', 'Sign-in expired', 'Reload this page'],
	] as const)('maps %s to useful copy', (error, title, message) => {
		const info = getLoginErrorInfo(error)

		expect(info?.title).toBe(title)
		expect(info?.message).toContain(message)
	})

	it('renders a persistent alert for Auth.js sign-in errors', () => {
		mocks.searchParams = new URLSearchParams({
			error: 'OAuthCallbackError',
		})

		const markup = renderToStaticMarkup(<Login providers={{}} />)

		expect(markup).toContain('role="alert"')
		expect(markup).toContain('Sign-in couldn&#x27;t be completed')
		expect(markup).toContain('choose a different sign-in method')
	})

	it('maps only allowlisted login messages to fixed copy', () => {
		expect(
			getLoginMessageInfo('Please log in first to connect Discord'),
		).toEqual({
			title: 'Login required',
			message: 'Log in before connecting Discord.',
		})
		expect(
			getLoginMessageInfo('customer@example.com Bearer private-token'),
		).toBeNull()
	})

	it('does not reflect arbitrary message or error query text', () => {
		const privateText = 'customer@example.com Bearer private-token'
		mocks.searchParams = new URLSearchParams({
			message: privateText,
			error: privateText,
		})

		const markup = renderToStaticMarkup(<Login providers={{}} />)

		expect(markup).not.toContain('customer@example.com')
		expect(markup).not.toContain('private-token')
		expect(markup).not.toContain('role="alert"')
	})
})

describe('Login email flow', () => {
	it('uses the Auth.js client sign-in flow instead of a stale server CSRF token', () => {
		const markup = renderToStaticMarkup(
			<Login
				providers={{
					postmark: {
						id: 'postmark',
						name: 'Email',
						type: 'email',
						style: { logo: '', bg: '', text: '' },
						signinUrl: '/api/auth/signin/postmark',
					},
				}}
				callbackUrl="/discord"
			/>,
		)

		expect(markup).toContain('<form data-form="" method="post"')
		expect(markup).toContain('type="email"')
		expect(markup).toContain('Email me a login link')
		expect(markup).not.toContain('action=')
		expect(markup).not.toContain('name="csrfToken"')
		expect(markup).not.toContain('name="callbackUrl"')
	})
})
