import { describe, expect, it, vi } from 'vitest'

vi.mock('next/headers', () => ({
	headers: async () => new Headers(),
}))
vi.mock('@/components/layout-client', () => ({ default: () => null }))
vi.mock('@/components/login', () => ({ Login: () => null }))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_SUPPORT_EMAIL: 's@example.com' },
}))
vi.mock('@/server/logger', () => ({ log: { error: vi.fn() } }))
vi.mock('@/server/auth', () => ({
	getProviders: () => ({
		postmark: { id: 'postmark' },
		github: { id: 'github' },
	}),
}))

import {
	AUTH_ERROR_CODES,
	AUTH_ERROR_VIEWS,
	GENERIC_AUTH_ERROR,
	authErrorView,
	resolveAuthErrorCode,
} from '@/lib/auth-error-view'
import { Login } from '@/components/login'

import AuthErrorPage from './page'

describe('auth error copy', () => {
	it.each(AUTH_ERROR_CODES)('%s has its own plain copy', (code) => {
		const view = authErrorView(code)
		expect(view).toBe(AUTH_ERROR_VIEWS[code])
		expect(view.title).not.toBe('Something went wrong')
		expect(view.title.toLowerCase()).not.toContain('configuration')
		expect(view.message.toLowerCase()).not.toContain('configuration')
	})

	it('AccessDenied says the account is not linked, as the signIn callback means it', () => {
		const view = authErrorView('AccessDenied')
		expect(view.title).toContain('not linked')
		expect(view.emailForm).toBe(true)
	})

	it('an expired or reused login link says so and offers the email form', () => {
		for (const code of ['Verification', 'Configuration'] as const) {
			const view = authErrorView(code)
			expect(view.emailForm).toBe(true)
			expect(view.message).toContain('Enter your email to get a new one')
		}
		expect(authErrorView('Verification').title).toContain(
			'expired or was already used',
		)
	})

	it.each([
		undefined,
		null,
		'',
		'Nope',
		'<script>alert(1)</script>',
		'toString',
		'__proto__',
	])('unknown code %s gets the generic view and is never echoed', (code) => {
		const view = authErrorView(code as string | null | undefined)
		expect(view).toBe(GENERIC_AUTH_ERROR)
		expect(JSON.stringify(view)).not.toContain(String(code || 'x-none'))
	})
})

describe('inactive recipient', () => {
	it('tells the person to contact support, with no address or email form', () => {
		const view = authErrorView('EmailInactive')
		expect(view.message).toBe(
			"We couldn't email you a login link. Please contact team@aihero.dev and we'll get you in.",
		)
		expect(view.emailForm).toBe(false)
		expect(JSON.stringify(view)).not.toMatch(/[\w.+-]+@(?!aihero\.dev)[\w.-]+/)
	})

	it('is reached only by the CredentialsSignin + EmailInactive pair', () => {
		expect(resolveAuthErrorCode('CredentialsSignin', 'EmailInactive')).toBe(
			'EmailInactive',
		)
		expect(resolveAuthErrorCode('CredentialsSignin', 'credentials')).toBe(
			'CredentialsSignin',
		)
		expect(resolveAuthErrorCode('EmailInactive', undefined)).toBe(
			'EmailInactive',
		)
		expect(resolveAuthErrorCode('Verification', 'EmailInactive')).toBe(
			'Verification',
		)
	})

	it('renders from the error page query', async () => {
		const element = await AuthErrorPage({
			searchParams: Promise.resolve({
				error: 'CredentialsSignin',
				code: 'EmailInactive',
			}),
		})
		const texts: string[] = []
		const walk = (node: unknown): void => {
			if (typeof node === 'string') texts.push(node)
			if (!node || typeof node !== 'object') return
			const props = (node as { props?: Record<string, unknown> }).props
			if (props) for (const v of Object.values(props)) walk(v)
			if (Array.isArray(node)) node.forEach(walk)
		}
		walk(element)
		expect(texts.join(' ')).toContain('contact team@aihero.dev')
	})
})

describe('auth error page login form', () => {
	it('never takes its callback from the query, and offers email only', async () => {
		const element = await AuthErrorPage({
			searchParams: Promise.resolve({
				error: 'Verification',
				callbackUrl: 'https://evil.example/steal',
			} as { error?: string }),
		})
		const found: Array<Record<string, any>> = []
		const walk = (node: unknown): void => {
			if (!node || typeof node !== 'object') return
			const el = node as { type?: unknown; props?: Record<string, any> }
			if (el.type === Login && el.props) found.push(el.props)
			for (const v of Object.values(el.props ?? {})) {
				if (Array.isArray(v)) v.forEach(walk)
				else walk(v)
			}
		}
		walk(element)
		expect(found).toHaveLength(1)
		expect(found[0]!.callbackUrl).toBe('/')
		expect(Object.keys(found[0]!.providers)).toEqual(['postmark'])
	})
})
