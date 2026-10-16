import { describe, expect, it } from 'vitest'

import {
	AUTH_ERROR_CODES,
	AUTH_ERROR_VIEWS,
	GENERIC_AUTH_ERROR,
	authErrorView,
} from '@/lib/auth-error-view'

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
