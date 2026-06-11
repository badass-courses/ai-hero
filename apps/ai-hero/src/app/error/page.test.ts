import { describe, expect, it } from 'vitest'

import { getErrorInfo } from './page'

describe('auth error page copy', () => {
	it('gives magic-link verification failures a recovery action', () => {
		const info = getErrorInfo('Verification')

		expect(info.title).toBe('Login link expired')
		expect(info.message).toContain('Request a fresh login link')
		expect(info.actions).toContainEqual(
			expect.objectContaining({
				label: 'Get a new login link',
				href: '/login',
			}),
		)
	})
})
