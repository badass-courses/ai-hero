import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

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

import { Login } from './login'

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
