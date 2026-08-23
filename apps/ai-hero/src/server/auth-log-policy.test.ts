import { describe, expect, it } from 'vitest'

import { OAuthCallbackError } from '@auth/core/errors'

import {
	getAuthErrorLogData,
	getAuthWarningLogData,
	getDiscordRefreshFailureKind,
	getNextAuthErrorLogLevel,
	getOAuthCallbackDebugLogData,
} from './auth-log-policy'

const ALL_UNKNOWN_LOG_DATA = {
	authErrorType: 'unknown',
	authErrorKind: 'unknown',
	authCauseType: 'unknown',
	authCauseCategory: 'unknown',
	authCauseCode: 'unknown',
	authFailureKind: 'unknown-failure',
	provider: 'unknown',
}

describe('auth log policy', () => {
	it('keeps generic AccessDenied wrappers actionable', () => {
		expect(getNextAuthErrorLogLevel({ type: 'AccessDenied' })).toBe('error')
		expect(getNextAuthErrorLogLevel({ name: 'AccessDenied' })).toBe('error')
	})

	it('keeps actionable OAuth callback failures at error level', () => {
		expect(getNextAuthErrorLogLevel({ type: 'OAuthCallbackError' })).toBe(
			'error',
		)
	})

	it('retains only allowlisted Auth.js cause metadata', () => {
		const cause = Object.assign(new Error('private database detail'), {
			code: 'ER_BAD_NULL_ERROR',
		})
		const error = Object.assign(new Error('Auth.js wrapper'), {
			type: 'AdapterError',
			kind: 'error',
			cause: {
				err: cause,
				provider: 'github',
				profile: { email: 'must-not-be-logged@example.com' },
				tokens: { access_token: 'must-not-be-logged' },
			},
		})

		const data = getAuthErrorLogData(error)

		expect(data).toEqual({
			authErrorType: 'AdapterError',
			authErrorKind: 'error',
			authCauseType: 'unknown',
			authCauseCategory: 'error',
			authCauseCode: 'unknown',
			authFailureKind: 'adapter-failure',
			provider: 'github',
		})
		expect(JSON.stringify(data)).not.toContain('private database detail')
		expect(JSON.stringify(data)).not.toContain('must-not-be-logged')
	})

	it('rejects arbitrary strings from every retained error field', () => {
		const secretValues = [
			'customer@example.com',
			'Bearer abc123-private-token',
			'account_987654321',
			'https://provider.example/private?id=42',
		]
		const cause = Object.assign(new Error(secretValues[1]), {
			name: secretValues[1],
			type: secretValues[2],
			code: secretValues[0],
		})
		const error = Object.assign(new Error(secretValues[3]), {
			name: secretValues[3],
			type: 'AdapterError',
			kind: secretValues[0],
			cause: {
				err: cause,
				provider: secretValues[2],
				providerId: secretValues[1],
			},
		})

		const serialized = JSON.stringify(getAuthErrorLogData(error))

		for (const secret of secretValues) {
			expect(serialized).not.toContain(secret)
		}
		expect(JSON.parse(serialized)).toEqual({
			authErrorType: 'AdapterError',
			authErrorKind: 'unknown',
			authCauseType: 'unknown',
			authCauseCategory: 'error',
			authCauseCode: 'unknown',
			authFailureKind: 'adapter-failure',
			provider: 'unknown',
		})
	})

	it('fails closed when a nested Proxy getPrototypeOf trap throws', () => {
		const trapText = 'PRIVATE_PROXY_PROTOTYPE_TRAP customer@example.com'
		const cause = new Proxy(
			{},
			{
				getPrototypeOf: () => {
					throw new Error(trapText)
				},
			},
		)
		const error = {
			type: 'AdapterError',
			kind: 'error',
			cause: { err: cause, provider: 'github' },
		}

		const data = getAuthErrorLogData(error)

		expect(data).toEqual(ALL_UNKNOWN_LOG_DATA)
		expect(JSON.stringify(data)).not.toContain(trapText)
	})

	it('fails closed when Proxy property getters throw', () => {
		const trapText = 'PRIVATE_PROXY_GET_TRAP Bearer private-token'
		const error = new Proxy(
			{},
			{
				get: () => {
					throw new Error(trapText)
				},
			},
		)

		const data = getAuthErrorLogData(error)

		expect(data).toEqual(ALL_UNKNOWN_LOG_DATA)
		expect(JSON.stringify(data)).not.toContain(trapText)
	})

	it('fails closed when an ordinary getter throws', () => {
		const trapText = 'PRIVATE_GETTER_TRAP account_987654'
		const error = Object.defineProperty({}, 'type', {
			get: () => {
				throw new Error(trapText)
			},
		})

		const data = getAuthErrorLogData(error)

		expect(data).toEqual(ALL_UNKNOWN_LOG_DATA)
		expect(JSON.stringify(data)).not.toContain(trapText)
	})

	it('fails closed when a custom prototype chain becomes hostile', () => {
		const trapText = 'PRIVATE_CUSTOM_PROTOTYPE_TRAP https://private.example'
		const hostilePrototype = new Proxy(
			{},
			{
				getPrototypeOf: () => {
					throw new Error(trapText)
				},
			},
		)
		const cause = Object.create(hostilePrototype)
		const error = {
			type: 'AdapterError',
			cause: { err: cause },
		}

		const data = getAuthErrorLogData(error)

		expect(data).toEqual(ALL_UNKNOWN_LOG_DATA)
		expect(JSON.stringify(data)).not.toContain(trapText)
	})

	it.each([undefined, null, 'private primitive', 42, true, Symbol('x')])(
		'projects primitive input %s to fixed unknown metadata',
		(error) => {
			expect(getAuthErrorLogData(error)).toEqual(ALL_UNKNOWN_LOG_DATA)
		},
	)

	it('handles the real Auth.js OAuthCallbackError and its separate debug metadata', () => {
		const metadata = {
			providerId: 'github',
			error: 'access_denied',
			error_description: 'customer@example.com denied private-account-123',
			error_uri: 'https://provider.example/private?token=secret',
		}
		const error = new OAuthCallbackError(
			'OAuth Provider returned an error',
			metadata,
		)

		// Auth.js 0.37 drops provider response metadata from this instance.
		expect(error.cause).toBeUndefined()
		expect(getAuthErrorLogData(error)).toEqual({
			authErrorType: 'OAuthCallbackError',
			authErrorKind: 'signIn',
			authCauseType: 'unknown',
			authCauseCategory: 'unknown',
			authCauseCode: 'unknown',
			authFailureKind: 'oauth-callback-failure',
			provider: 'unknown',
		})

		const debugData = getOAuthCallbackDebugLogData(
			'OAuthCallbackError',
			metadata,
		)
		expect(debugData).toEqual({
			authFailureKind: 'user-denied',
			oauthResultCode: 'access_denied',
			provider: 'github',
		})
		expect(JSON.stringify(debugData)).not.toContain('customer@example.com')
		expect(JSON.stringify(debugData)).not.toContain('private-account-123')
		expect(JSON.stringify(debugData)).not.toContain('secret')
	})

	it.each([
		['access_denied', 'user-denied'],
		['server_error', 'provider-unavailable'],
		['temporarily_unavailable', 'provider-unavailable'],
		['invalid_request', 'invalid-request'],
		['customer@example.com', 'unknown-oauth-failure'],
	] as const)(
		'allowlists OAuth callback result %s as %s',
		(errorCode, failureKind) => {
			expect(
				getOAuthCallbackDebugLogData('OAuthCallbackError', {
					providerId: 'github',
					error: errorCode,
					error_description: 'must-not-be-logged',
				}),
			).toEqual({
				authFailureKind: failureKind,
				oauthResultCode:
					errorCode === 'customer@example.com' ? 'unknown' : errorCode,
				provider: 'github',
			})
		},
	)

	it('ignores unrelated Auth.js debug events and metadata', () => {
		expect(
			getOAuthCallbackDebugLogData('callback route error details', {
				body: { email: 'customer@example.com' },
			}),
		).toBeNull()
	})

	it('allowlists Auth.js warning codes', () => {
		expect(getAuthWarningLogData('csrf-disabled')).toEqual({
			code: 'csrf-disabled',
		})
		expect(getAuthWarningLogData('customer@example.com private-token')).toEqual(
			{
				code: 'unknown',
			},
		)
	})

	it('requires Discord invalid_grant before entering the relink state', () => {
		expect(getDiscordRefreshFailureKind(400, 'invalid_grant')).toBe(
			'user-must-relink',
		)
		expect(getDiscordRefreshFailureKind(400, 'invalid_request')).toBe('failed')
		expect(getDiscordRefreshFailureKind(401, 'invalid_grant')).toBe('failed')
		expect(getDiscordRefreshFailureKind(500, null)).toBe('failed')
	})
})
