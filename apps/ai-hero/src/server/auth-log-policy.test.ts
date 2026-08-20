import { describe, expect, it } from 'vitest'

import { getNextAuthErrorLogLevel } from './auth-log-policy'

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

})
