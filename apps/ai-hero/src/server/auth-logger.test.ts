import { describe, expect, it, vi } from 'vitest'

import { createSafeAuthLogger } from './auth-logger'

function createSink() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}
}

describe('safe Auth.js logger', () => {
	it('keeps a provider cancellation as a safe actionable reason code', () => {
		const sink = createSink()
		const logger = createSafeAuthLogger(sink)

		logger.debug('OAuthCallbackError', {
			providerId: 'discord',
			error: 'access_denied',
			error_description: 'customer@example.com denied provider-account-123',
			access_token: 'private-access-token',
		})

		expect(sink.warn).toHaveBeenCalledWith('auth.nextauth.oauth-callback', {
			provider: 'discord',
			reasonCode: 'provider-cancelled',
			oauthResultCode: 'access_denied',
		})
		expect(JSON.stringify(sink.warn.mock.calls)).not.toContain(
			'customer@example.com',
		)
		expect(JSON.stringify(sink.warn.mock.calls)).not.toContain(
			'provider-account-123',
		)
		expect(JSON.stringify(sink.warn.mock.calls)).not.toContain(
			'private-access-token',
		)
	})

	it('redacts arbitrary callback metadata and error messages', () => {
		const sink = createSink()
		const logger = createSafeAuthLogger(sink)
		const privateValues = [
			'customer@example.com',
			'Bearer private-token',
			'provider-account-123',
			'private-session-token',
			'private-oauth-state',
		]

		logger.debug('authorization result', {
			profile: { email: privateValues[0] },
			tokens: { access_token: privateValues[1] },
			account: { id: privateValues[2] },
			state: privateValues[4],
		})
		logger.debug('adapter_getSessionAndUser', { args: [privateValues[3]] })
		logger.debug('OAuthCallbackError', {
			providerId: privateValues[2],
			error: privateValues[0],
			error_description: privateValues.join(' '),
		})
		logger.error(
			Object.assign(new Error(privateValues.join(' ')), {
				type: 'OAuthCallbackError',
				account: { id: privateValues[2] },
			}),
		)

		const serialized = JSON.stringify({
			warn: sink.warn.mock.calls,
			error: sink.error.mock.calls,
		})
		for (const value of privateValues) {
			expect(serialized).not.toContain(value)
		}
		expect(sink.error).toHaveBeenNthCalledWith(
			1,
			'auth.nextauth.oauth-callback',
			{
				provider: 'unknown',
				reasonCode: 'unknown-oauth-failure',
				oauthResultCode: 'unknown',
			},
		)
		expect(sink.error).toHaveBeenNthCalledWith(2, 'auth.nextauth.error', {
			errorType: 'OAuthCallbackError',
			reasonCode: 'oauth-callback-failed',
		})
	})

	it('never lets a failed log sink break authentication', () => {
		const logger = createSafeAuthLogger({
			info: () => {
				throw new Error('sink failed')
			},
			warn: () => {
				throw new Error('sink failed')
			},
			error: () => {
				throw new Error('sink failed')
			},
		})

		expect(() => logger.error(new Error('private'))).not.toThrow()
		expect(() =>
			logger.debug('OAuthCallbackError', {
				providerId: 'discord',
				error: 'server_error',
			}),
		).not.toThrow()
	})
})
