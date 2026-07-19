import { describe, expect, it } from 'vitest'

import { signValuePathToken, verifyValuePathToken } from './path-token'

const secret = 'test-value-path-token-secret'
const expiredPayload = {
	contactId: 'contact-1',
	kitSubscriberId: 'kit-1',
	valuePathResourceId: 'ai-hero-skills-workflow',
	emailResourceId: 'ai-hero-skills-workflow.email-7',
	sequenceId: 'ai-hero-skills-workflow',
	expiresAt: '2026-07-01T00:00:00.000Z',
}
const now = new Date('2026-07-18T00:00:00.000Z')

describe('value path token expiration policy', () => {
	it('accepts an authentic expired token only when the caller explicitly allows it', () => {
		const token = signValuePathToken({ payload: expiredPayload, secret })

		expect(verifyValuePathToken({ token, secret, now })).toEqual({
			valid: false,
			reason: 'expired',
		})
		expect(
			verifyValuePathToken({
				token,
				secret,
				now,
				expirationPolicy: 'allow-expired',
			}),
		).toEqual({ valid: true, payload: expiredPayload })
	})

	it('still rejects a tampered token when expired tokens are allowed', () => {
		const token = signValuePathToken({ payload: expiredPayload, secret })
		const separatorIndex = token.indexOf('.')
		const encodedPayload = token.slice(0, separatorIndex)
		const signature = token.slice(separatorIndex + 1)
		const tamperedPayload = `${encodedPayload[0] === 'e' ? 'f' : 'e'}${encodedPayload.slice(1)}`
		const tampered = `${tamperedPayload}.${signature}`

		expect(
			verifyValuePathToken({
				token: tampered,
				secret,
				now,
				expirationPolicy: 'allow-expired',
			}),
		).toEqual({ valid: false, reason: 'tampered' })
	})
})
