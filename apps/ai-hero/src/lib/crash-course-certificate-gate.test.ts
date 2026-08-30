import { describe, expect, it, vi } from 'vitest'

import type { CrashCourseCertificateEligibility } from './crash-course-certificate-eligibility'
import {
	decideCrashCourseCertificateGate,
	isCrashCourseCertificateV1Enabled,
	readCrashCourseCertificateGate,
} from './crash-course-certificate-gate'

const grantedEligibility: CrashCourseCertificateEligibility = {
	eligible: true,
	userId: 'user-1',
	courseResourceId: 'workshop-2ozd9',
	finalQuizLessonId: 'sync_lesson_800b577c51997b78aa74a65c',
	completedAt: new Date('2026-08-30T12:00:07.000Z'),
	correctAnswers: 8,
	requiredAnswers: 8,
}

describe('Crash Course certificate gate', () => {
	it('defaults off and enables only for the exact true value', () => {
		expect(isCrashCourseCertificateV1Enabled(undefined)).toBe(false)
		expect(isCrashCourseCertificateV1Enabled('false')).toBe(false)
		expect(isCrashCourseCertificateV1Enabled('1')).toBe(false)
		expect(isCrashCourseCertificateV1Enabled('true')).toBe(true)
	})

	it('preserves the existing certificate path while rollout is disabled', () => {
		expect(
			decideCrashCourseCertificateGate({
				enabled: false,
				eligibility: grantedEligibility,
			}),
		).toEqual({ status: 'disabled' })
	})

	it('grants only from eligible quiz evidence', () => {
		expect(
			decideCrashCourseCertificateGate({
				enabled: true,
				eligibility: grantedEligibility,
			}),
		).toEqual({ status: 'granted', eligibility: grantedEligibility })
	})

	it.each([
		{
			reason: 'answers-missing' as const,
			correctAnswers: 5,
			requiredAnswers: 8,
		},
		{
			reason: 'answers-incorrect' as const,
			correctAnswers: 7,
			requiredAnswers: 8,
		},
	])('returns a learner-actionable lock for $reason', (eligibility) => {
		expect(
			decideCrashCourseCertificateGate({
				enabled: true,
				eligibility: { eligible: false, ...eligibility },
			}),
		).toEqual({ status: 'locked', ...eligibility })
	})

	it.each([
		'course-not-found',
		'final-quiz-not-configured',
		'final-quiz-empty',
		'final-quiz-question-set-mismatch',
		'not-authenticated',
	] as const)('treats %s as temporary unavailability', (reason) => {
		expect(
			decideCrashCourseCertificateGate({
				enabled: true,
				eligibility: { eligible: false, reason },
			}),
		).toEqual({ status: 'unavailable', reason })
	})

	it('treats query failure as temporary unavailability', () => {
		expect(
			decideCrashCourseCertificateGate({
				enabled: true,
				queryFailed: true,
			}),
		).toEqual({ status: 'unavailable', reason: 'query-failed' })
	})

	it('does no eligibility work while disabled', async () => {
		const checkEligibility = vi.fn()

		await expect(
			readCrashCourseCertificateGate(
				{ userId: 'user-1' },
				{ enabled: false, checkEligibility },
			),
		).resolves.toEqual({ status: 'disabled' })
		expect(checkEligibility).not.toHaveBeenCalled()
	})

	it('contains eligibility exceptions as unavailable gate state', async () => {
		await expect(
			readCrashCourseCertificateGate(
				{ userId: 'user-1' },
				{
					enabled: true,
					checkEligibility: vi
						.fn()
						.mockRejectedValue(new Error('database down')),
				},
			),
		).resolves.toEqual({ status: 'unavailable', reason: 'query-failed' })
	})
})
