import { describe, expect, it, vi } from 'vitest'

import {
	INVALID_LOGIN_EMAIL_REDIRECT,
	isPlausibleLoginEmail,
	withLoginEmailGuard,
} from './login-email'

describe('isPlausibleLoginEmail', () => {
	it('rejects malformed addresses', () => {
		for (const bad of [
			'a@b',
			'name@gmailcom',
			'name',
			'@x.com',
			'a b@x.com',
			'a@@x.com',
			'a@x.',
			'a@.com',
			'',
			null,
		]) {
			expect(isPlausibleLoginEmail(bad), String(bad)).toBe(false)
		}
	})

	it('accepts ordinary addresses', () => {
		for (const ok of [
			'name@example.com',
			' name@example.com ',
			'a+b@mail.example.co.uk',
		]) {
			expect(isPlausibleLoginEmail(ok), ok).toBe(true)
		}
	})
})

describe('withLoginEmailGuard', () => {
	it('redirects a malformed magic-link request without calling next', async () => {
		const next = vi.fn().mockResolvedValue(true)
		const guarded = withLoginEmailGuard(next)
		await expect(
			guarded({
				user: { email: 'name@gmailcom' },
				email: { verificationRequest: true },
			}),
		).resolves.toBe(INVALID_LOGIN_EMAIL_REDIRECT)
		expect(next).not.toHaveBeenCalled()
	})

	it('passes valid magic-link and non-email sign-ins through', async () => {
		const next = vi.fn().mockResolvedValue(true)
		const guarded = withLoginEmailGuard(next)
		await expect(
			guarded({
				user: { email: 'name@example.com' },
				email: { verificationRequest: true },
			}),
		).resolves.toBe(true)
		await expect(guarded({ user: { email: 'a@b' } })).resolves.toBe(true)
		expect(next).toHaveBeenCalledTimes(2)
	})
})
