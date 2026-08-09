import { describe, expect, it } from 'vitest'

import {
	getDiscordRefreshFailureKind,
	getNextAuthErrorLogLevel,
} from './auth-log-policy'

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

	it('requires Discord invalid_grant before entering the relink state', () => {
		expect(getDiscordRefreshFailureKind(400, 'invalid_grant')).toBe(
			'user-must-relink',
		)
		expect(getDiscordRefreshFailureKind(400, 'invalid_request')).toBe('failed')
		expect(getDiscordRefreshFailureKind(401, 'invalid_grant')).toBe('failed')
		expect(getDiscordRefreshFailureKind(500, null)).toBe('failed')
	})
})
