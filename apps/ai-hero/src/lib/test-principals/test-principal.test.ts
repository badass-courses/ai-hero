import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
	isSyntheticPrincipalEmail,
	isSyntheticPrincipalId,
} from '@/lib/synthetic-principal'

import {
	authJsSecret,
	hashVerificationToken,
	TestPrincipalRequestSchema,
	testPrincipalIdentity,
	testPrincipalSignIn,
} from './test-principal'

describe('test principal identity', () => {
	it('names one synthetic principal per runId, the same every time', () => {
		const first = testPrincipalIdentity('run-12345678')
		expect(testPrincipalIdentity('run-12345678')).toEqual(first)
		expect(testPrincipalIdentity('run-87654321').principalId).not.toBe(first.principalId)
		expect(first.contactId).toBe(first.principalId)
		expect(isSyntheticPrincipalId(first.principalId)).toBe(true)
		expect(first.principalId).toMatch(/^synthetic_[0-9a-f]{24}$/)
		expect(first.email).toBe('run-12345678@synthetic.aihero.invalid')
		expect(isSyntheticPrincipalEmail(first.email)).toBe(true)
	})

	it('accepts only a strict request with one recipient persona and a bounded runId', () => {
		const ok = {
			runId: 'run-12345678',
			tenantId: 'org-aihero',
			personas: ['recipient'],
			emailKeys: ['email-1'],
		}
		expect(TestPrincipalRequestSchema.safeParse(ok).success).toBe(true)
		for (const bad of [
			{ ...ok, runId: 'short' },
			{ ...ok, runId: 'Has-Upper-1234' },
			{ ...ok, runId: 'run 12345678' },
			{ ...ok, personas: ['stranger'] },
			{ ...ok, personas: [] },
			{ ...ok, emailKeys: Array.from({ length: 51 }, (_, i) => `k${i}`) },
			{ ...ok, extra: true },
			{ ...ok, evergreenCoupon: 'other' },
		]) {
			expect(TestPrincipalRequestSchema.safeParse(bad).success).toBe(false)
		}
	})
})

describe('one-time sign-in', () => {
	it('hashes the token the way @auth/core 0.37.2 stores and checks it', () => {
		const expected = createHash('sha256').update('raw-token' + 'auth-secret').digest('hex')
		expect(hashVerificationToken('raw-token', 'auth-secret')).toBe(expected)
	})

	it('uses the secret Auth.js reads: AUTH_SECRET, else NEXTAUTH_SECRET', () => {
		expect(authJsSecret({ AUTH_SECRET: 'a', NEXTAUTH_SECRET: 'b' })).toBe('a')
		expect(authJsSecret({ NEXTAUTH_SECRET: 'b' })).toBe('b')
		expect(authJsSecret({})).toBeUndefined()
	})

	it('returns the magic-link callback and the confirm step the runner must take', () => {
		const signIn = testPrincipalSignIn({
			origin: 'https://www.aihero.dev',
			email: 'run-12345678@synthetic.aihero.invalid',
			rawToken: 'raw-token',
			expiresAt: new Date('2026-09-25T00:05:00.000Z'),
		})
		const url = new URL(signIn.url)
		expect(url.origin + url.pathname).toBe(
			'https://www.aihero.dev/api/auth/callback/postmark',
		)
		expect([...url.searchParams.keys()]).toEqual(['callbackUrl', 'token', 'email'])
		expect(url.searchParams.get('token')).toBe('raw-token')
		expect(url.searchParams.get('email')).toBe('run-12345678@synthetic.aihero.invalid')
		expect(signIn.confirm).toEqual({ method: 'POST', path: '/api/auth/magic-link/confirm' })
		expect(signIn.expiresAt).toBe('2026-09-25T00:05:00.000Z')
	})
})
