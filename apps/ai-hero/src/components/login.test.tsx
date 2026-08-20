import { readFileSync } from 'node:fs'
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

const loginPageSource = readFileSync(
	new URL('../app/(user)/login/page.tsx', import.meta.url),
	'utf8',
)

const oauthProviders = {
	github: {
		id: 'github',
		name: 'GitHub',
		type: 'oauth',
		style: { logo: '', bg: '', text: '' },
		signinUrl: '/api/auth/signin/github',
	},
	discord: {
		id: 'discord',
		name: 'Discord',
		type: 'oauth',
		style: { logo: '', bg: '', text: '' },
		signinUrl: '/api/auth/signin/discord',
	},
}

describe('Login provider choices', () => {
	it('offers both login services with exact non-restrictive labels', () => {
		const markup = renderToStaticMarkup(
			<Login providers={oauthProviders} callbackUrl="/profile" />,
		)

		expect(markup).toContain('Continue with GitHub')
		expect(markup).toContain('Continue with Discord')
		expect(markup).not.toContain('Sign in with existing')
		expect(loginPageSource).toContain(
			'Choose GitHub, Discord, or email to continue.',
		)
		expect(loginPageSource).not.toContain('only sign in to accounts already linked')
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
