// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signIn } from 'next-auth/react'

vi.mock('next/navigation', () => ({
	useSearchParams: () => new URLSearchParams(),
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

import { Login, requestEmailLogin } from './login'
import { authErrorView } from '@/lib/auth-error-view'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('inline email sign-in result', () => {
	it('keeps the successful Auth.js verify-request destination', async () => {
		const url =
			'https://app.example.test/api/auth/verify-request?provider=postmark&type=email'
		vi.mocked(signIn).mockResolvedValue({
			error: undefined,
			code: undefined,
			status: 200,
			ok: true,
			url,
		} as any)
		const navigate = vi.fn()
		expect(
			await requestEmailLogin(
				'postmark',
				'person@example.test',
				'/discord',
				navigate,
			),
		).toBeUndefined()
		expect(signIn).toHaveBeenCalledWith('postmark', {
			email: 'person@example.test',
			callbackUrl: '/discord',
			redirect: false,
		})
		expect(navigate).toHaveBeenCalledWith(url)
	})
	it('shows a rejection and suggestion inline without navigating', async () => {
		vi.mocked(signIn).mockResolvedValue({
			error: 'CredentialsSignin',
			code: 'EmailRejected:other.example.test',
		} as any)
		const navigate = vi.fn()
		expect(
			await requestEmailLogin('postmark', 'person@example.test', '/', navigate),
		).toBe(
			"We can't send a sign-in link to that address. Please use a different email. Did you mean person@other.example.test?",
		)
		expect(navigate).not.toHaveBeenCalled()
	})
	it('keeps the inactive-recipient message', async () => {
		vi.mocked(signIn).mockResolvedValue({
			error: 'CredentialsSignin',
			code: 'EmailInactive',
		} as any)
		expect(
			await requestEmailLogin('postmark', 'person@example.test', '/', vi.fn()),
		).toBe(authErrorView('EmailInactive').message)
	})
	it.each([
		undefined,
		{ error: 'Configuration' },
		{ error: 'CredentialsSignin', code: 'unexpected' },
	])(
		'shows the generic message for unexpected response %j',
		async (response) => {
			vi.mocked(signIn).mockResolvedValue(response as any)
			expect(
				await requestEmailLogin(
					'postmark',
					'person@example.test',
					'/',
					vi.fn(),
				),
			).toBe(authErrorView(undefined).message)
		},
	)
	it('shows the generic message on client/network exceptions', async () => {
		vi.mocked(signIn).mockRejectedValue(new Error('network'))
		expect(
			await requestEmailLogin('postmark', 'person@example.test', '/', vi.fn()),
		).toBe(authErrorView(undefined).message)
	})
})

describe('Login email flow', () => {
	it.each([
		[
			'EmailRejected:other.example.test',
			'Did you mean person@other.example.test?',
		],
		['EmailInactive', authErrorView('EmailInactive').message],
		['unexpected', authErrorView(undefined).message],
	])('renders %s inline with the email field', async (code, message) => {
		;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
		vi.mocked(signIn).mockResolvedValue({
			error: 'CredentialsSignin',
			code,
		} as any)
		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)
		try {
			await act(async () =>
				root.render(
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
					/>,
				),
			)
			const input = container.querySelector(
				'input[type="email"]',
			) as HTMLInputElement
			await act(async () => {
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					'value',
				)!.set!.call(input, 'person@example.test')
				input.dispatchEvent(new Event('input', { bubbles: true }))
			})
			await act(async () => {
				container
					.querySelector('form')!
					.dispatchEvent(
						new Event('submit', { bubbles: true, cancelable: true }),
					)
			})
			expect(
				container.querySelector('[data-email-error]')?.textContent,
			).toContain(message)
			expect(input.getAttribute('aria-invalid')).toBe('true')
		} finally {
			await act(async () => root.unmount())
			container.remove()
		}
	})
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
