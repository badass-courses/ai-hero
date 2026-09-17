import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
	SKILLS_COURSE_RECOVERY_TOKEN_PURPOSE,
	SKILLS_COURSE_RECOVERY_TOKEN_TTL_MS,
	signSkillsCourseRecoveryToken,
	verifySkillsCourseRecoveryToken,
} from './skills-course-recovery-token'

const now = new Date('2026-08-20T12:00:00.000Z')
const secret = 'recovery-test-secret'

describe('skills course recovery token', () => {
	it('verifies a purpose-bound token before its fixed expiry', () => {
		const token = signSkillsCourseRecoveryToken({
			kitSubscriberId: '41',
			email: ' Learner@Example.com ',
			secret,
			now,
		})

		expect(verifySkillsCourseRecoveryToken({ token, secret, now })).toEqual({
			valid: true,
			payload: {
				version: 1,
				purpose: SKILLS_COURSE_RECOVERY_TOKEN_PURPOSE,
				kitSubscriberId: '41',
				email: 'learner@example.com',
				issuedAt: now.toISOString(),
				expiresAt: new Date(
					now.getTime() + SKILLS_COURSE_RECOVERY_TOKEN_TTL_MS,
				).toISOString(),
			},
		})
	})

	it('rejects a token after expiry', () => {
		const token = signSkillsCourseRecoveryToken({
			kitSubscriberId: '41',
			email: 'learner@example.com',
			secret,
			now,
		})

		expect(
			verifySkillsCourseRecoveryToken({
				token,
				secret,
				now: new Date(now.getTime() + SKILLS_COURSE_RECOVERY_TOKEN_TTL_MS),
			}),
		).toEqual({ valid: false, reason: 'expired' })
	})

	it('rejects a valid signature made for another purpose', () => {
		const payload = Buffer.from(
			JSON.stringify({
				version: 1,
				purpose: 'another-purpose',
				kitSubscriberId: '41',
				email: 'learner@example.com',
				issuedAt: now.toISOString(),
				expiresAt: new Date(
					now.getTime() + SKILLS_COURSE_RECOVERY_TOKEN_TTL_MS,
				).toISOString(),
			}),
		).toString('base64url')
		const signature = createHmac('sha256', secret)
			.update(payload)
			.digest('base64url')

		expect(
			verifySkillsCourseRecoveryToken({
				token: `${payload}.${signature}`,
				secret,
				now,
			}),
		).toEqual({ valid: false, reason: 'malformed' })
	})

	it('rejects a subscriber id changed by the browser', () => {
		const token = signSkillsCourseRecoveryToken({
			kitSubscriberId: '41',
			email: 'learner@example.com',
			secret,
			now,
		})
		const [encodedPayload, signature] = token.split('.')
		if (!encodedPayload || !signature)
			throw new Error('test token is malformed')
		const payload = JSON.parse(
			Buffer.from(encodedPayload, 'base64url').toString('utf8'),
		) as Record<string, unknown>
		payload.kitSubscriberId = '999'
		const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString(
			'base64url',
		)

		expect(
			verifySkillsCourseRecoveryToken({
				token: `${tamperedPayload}.${signature}`,
				secret,
				now,
			}),
		).toEqual({ valid: false, reason: 'tampered' })
	})
})
