import { describe, expect, it, vi } from 'vitest'

import { createPostSignInInvitationHandler } from './auth-post-sign-in'
import {
	redactCredentials,
	redactedErrorMessage,
	serializeError,
} from './logger-utils'

const jwt =
	'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

describe('redactCredentials', () => {
	it('redacts a Bearer token, case-insensitively', () => {
		expect(redactCredentials('Authorization: Bearer abc123.def-456_ghi')).toBe(
			'Authorization: Bearer [REDACTED]',
		)
		expect(redactCredentials('bearer abcdef123456 failed')).toBe(
			'Bearer [REDACTED] failed',
		)
	})

	it('redacts a JWT and keeps the surrounding text', () => {
		expect(redactCredentials(`token ${jwt} was rejected`)).toBe(
			'token [REDACTED_JWT] was rejected',
		)
	})

	it('redacts a Bearer JWT and several in mixed text', () => {
		const text = `GET /x with Bearer ${jwt}; retry with ${jwt}, then Bearer secrettoken99`
		const out = redactCredentials(text)
		expect(out).toBe(
			'GET /x with Bearer [REDACTED]; retry with [REDACTED_JWT], then Bearer [REDACTED]',
		)
		expect(out).not.toContain('eyJ')
	})

	it('leaves normal text, ids and dotted names alone', () => {
		for (const text of [
			'Connection refused at 10.0.0.1:3306',
			'user_01HZX9K2 not found',
			'a.b.c and eyJ.only',
			'the bearer of bad news',
			'Unexpected token < in JSON at position 0',
			'550e8400-e29b-41d4-a716-446655440000',
		]) {
			expect(redactCredentials(text)).toBe(text)
		}
	})
})

describe('serializeError credential redaction', () => {
	it('redacts message, stack, nested cause, errors and string props', () => {
		const cause = new Error(`upstream said Bearer ${'x'.repeat(20)}`)
		const error = Object.assign(new Error(`bad token ${jwt}`, { cause }), {
			path: `/cb?t=${jwt}`,
			code: 'E_AUTH',
		})
		const aggregate = new AggregateError(
			[new Error('Bearer aggregate-secret-1')],
			'many',
		)
		const serialized = serializeError(error)
		const json = JSON.stringify([serialized, serializeError(aggregate)])

		expect(serialized.message).toBe('bad token [REDACTED_JWT]')
		expect(serialized.stack).toContain('bad token [REDACTED_JWT]')
		expect(serialized.stack).toContain('at ')
		expect(serialized.cause?.message).toBe('upstream said Bearer [REDACTED]')
		expect(serialized.cause?.stack).not.toContain('xxxxxxxx')
		expect(serialized.path).toBe('/cb?t=[REDACTED_JWT]')
		expect(serialized.code).toBe('E_AUTH')
		expect(serializeError(aggregate).errors?.[0]?.message).toBe(
			'Bearer [REDACTED]',
		)
		expect(json).not.toContain('eyJ')
		expect(json).not.toContain('aggregate-secret')
	})

	it('redacts non-Error throws', () => {
		expect(serializeError(`Bearer ${'y'.repeat(12)}`).message).toBe(
			'Bearer [REDACTED]',
		)
		expect(serializeError({ message: `jwt ${jwt}` }).message).toBe(
			'jwt [REDACTED_JWT]',
		)
	})
})

describe('error.message call sites', () => {
	it('redactedErrorMessage handles Error and non-Error values', () => {
		expect(redactedErrorMessage(new Error(`Bearer ${'z'.repeat(10)}`))).toBe(
			'Bearer [REDACTED]',
		)
		expect(redactedErrorMessage(`oops ${jwt}`)).toBe('oops [REDACTED_JWT]')
	})

	it('post-sign-in failure log carries a redacted error string', async () => {
		const logFailed = vi.fn()
		const handler = createPostSignInInvitationHandler({
			acceptInvitations: async () => {
				throw new Error(`invite failed for Bearer ${'q'.repeat(12)}`)
			},
			logAccepted: vi.fn(),
			logFailed,
		})

		await handler({ user: { id: 'u1', email: 'a@example.com' } })

		expect(logFailed).toHaveBeenCalledWith({
			userId: 'u1',
			error: 'invite failed for Bearer [REDACTED]',
		})
	})
})
