import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getServerAuthSession: vi.fn(),
	inngestSend: vi.fn(),
	log: { error: vi.fn(), info: vi.fn() },
	readRecoveryToken: vi.fn(),
	standing: vi.fn(),
}))

vi.mock('@/lib/skills-course/recovery-standing', () => ({
	readRecoveryStanding: mocks.standing,
}))
vi.mock('@/lib/skills-course/recovery-standing.server', () => ({
	createRecoveryStandingReader: () => ({}),
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send: mocks.inngestSend },
}))
vi.mock(
	'@/lib/subscriber-marketing/skills-course-recovery-token.server',
	() => ({
		readSkillsCourseRecoveryToken: mocks.readRecoveryToken,
	}),
)
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { resendSkillsCourseLessonOne } from './skills-course-restart-actions'

describe('resendSkillsCourseLessonOne', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { email: 'learner@example.com' } },
		})
		mocks.standing.mockResolvedValue({
			state: 'subscribed',
			contactId: 'contact_41',
			email: 'learner@example.com',
			kitSubscriberId: '41',
		})
		mocks.log.info.mockResolvedValue(undefined)
		mocks.readRecoveryToken.mockResolvedValue({
			valid: false,
			reason: 'missing',
		})
		mocks.inngestSend.mockResolvedValue({ ids: ['event-1'] })
		mocks.log.error.mockResolvedValue(undefined)
	})

	it('queues only after the server session email has a subscribed standing', async () => {
		await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
			success: true,
		})

		expect(mocks.standing).toHaveBeenCalledWith(
			expect.objectContaining({ email: 'learner@example.com' }),
		)
		expect(mocks.readRecoveryToken).toHaveBeenCalledTimes(1)
		expect(mocks.inngestSend).toHaveBeenCalledWith({
			id: expect.stringMatching(/^skills-course-lesson-one-recovery:/),
			name: 'skills-course/lesson-one-recovery.requested',
			data: {
				requestId: expect.any(String),
				recoveryKey: expect.stringMatching(/^[a-f0-9]{64}$/),
				requestedAt: expect.any(String),
				kitSubscriberId: '41',
				source: 'authenticated-session',
			},
		})
		const queued = mocks.inngestSend.mock.calls[0]?.[0]
		expect(JSON.stringify(queued)).not.toContain('learner@example.com')
	})

	it('queues from an unexpired server-signed recovery token', async () => {
		mocks.getServerAuthSession.mockResolvedValue({ session: null })
		mocks.readRecoveryToken.mockResolvedValue({
			valid: true,
			payload: {
				kitSubscriberId: '41',
				email: 'learner@example.com',
			},
		})

		await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
			success: true,
		})
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ source: 'signed-recovery-token' }),
			}),
		)
	})

	it('uses a valid recovery token instead of a different signed-in account', async () => {
		mocks.readRecoveryToken.mockResolvedValue({
			valid: true,
			payload: {
				kitSubscriberId: '52',
				email: 'course-reader@example.com',
			},
		})
		mocks.standing.mockResolvedValue({
			state: 'subscribed',
			contactId: 'contact_52',
			email: 'course-reader@example.com',
			kitSubscriberId: '52',
		})

		await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
			success: true,
		})
		expect(mocks.standing).toHaveBeenCalledWith(
			expect.objectContaining({
				email: 'course-reader@example.com',
				expectedKitSubscriberId: '52',
			}),
		)
		expect(mocks.getServerAuthSession).not.toHaveBeenCalled()
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					kitSubscriberId: '52',
					source: 'signed-recovery-token',
				}),
			}),
		)
	})

	it('does not let a signed token enqueue an arbitrary subscriber id', async () => {
		mocks.getServerAuthSession.mockResolvedValue({ session: null })
		mocks.readRecoveryToken.mockResolvedValue({
			valid: true,
			payload: {
				kitSubscriberId: '999',
				email: 'learner@example.com',
			},
		})

		await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
			success: false,
			reason: 'not-identified',
		})
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('does not use an arbitrary ck_subscriber or ck_subscriber_id without authorization', async () => {
		mocks.getServerAuthSession.mockResolvedValue({ session: null })

		await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
			success: false,
			reason: 'not-identified',
		})
		expect(mocks.standing).not.toHaveBeenCalled()
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('does not enqueue from an unsigned, tampered, or expired browser token', async () => {
		mocks.getServerAuthSession.mockResolvedValue({ session: null })
		mocks.readRecoveryToken.mockResolvedValue({
			valid: false,
			reason: 'tampered',
		})

		await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
			success: false,
			reason: 'not-identified',
		})
		expect(mocks.standing).not.toHaveBeenCalled()
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('uses one stable opaque idempotency key for an authorized subscriber', async () => {
		await resendSkillsCourseLessonOne()
		await resendSkillsCourseLessonOne()

		const firstEvent = mocks.inngestSend.mock.calls[0]?.[0]
		const secondEvent = mocks.inngestSend.mock.calls[1]?.[0]
		expect(firstEvent.data.recoveryKey).toBe(secondEvent.data.recoveryKey)
		expect(firstEvent.id).not.toBe(secondEvent.id)
	})

	it('redacts identity and provider errors when queueing fails', async () => {
		mocks.inngestSend.mockRejectedValue(
			new Error('429 learner@example.com subscriber 41'),
		)

		await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
			success: false,
			reason: 'request-failed',
		})
		const logged = JSON.stringify(mocks.log.error.mock.calls)
		expect(logged).not.toContain('learner@example.com')
		expect(logged).not.toContain('41')
		expect(mocks.log.error).toHaveBeenCalledWith(
			'skills.course.lesson_one_recovery_enqueue_failed',
			{ outcome: 'not-queued' },
		)
	})

	describe('local standing', () => {

		it('subscribed: queues with the directory Kit alias', async () => {
			mocks.standing.mockResolvedValue({
				state: 'subscribed',
				contactId: 'contact_41',
				email: 'learner@example.com',
				kitSubscriberId: '41',
			})

			await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
				success: true,
			})
			expect(mocks.standing).toHaveBeenCalledWith(
				expect.objectContaining({ email: 'learner@example.com' }),
			)
			expect(mocks.inngestSend).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ kitSubscriberId: '41' }),
				}),
			)
			// State only: no email, contact or Kit id in the receipt.
			expect(mocks.log.info).toHaveBeenCalledWith(
				'skills.course.lesson_one_recovery_standing',
				{ state: 'subscribed' },
			)
		})

		it('signed token: the token Kit id is the one checked', async () => {
			mocks.getServerAuthSession.mockResolvedValue({ session: null })
			mocks.readRecoveryToken.mockResolvedValue({
				valid: true,
				payload: { kitSubscriberId: '52', email: 'learner@example.com' },
			})
			mocks.standing.mockResolvedValue({
				state: 'subscribed',
				contactId: 'contact_41',
				email: 'learner@example.com',
				kitSubscriberId: '52',
			})

			await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
				success: true,
			})
			expect(mocks.standing).toHaveBeenCalledWith(
				expect.objectContaining({ expectedKitSubscriberId: '52' }),
			)
		})

		it('stopped: queues nothing and offers no resubscribe detour', async () => {
			mocks.standing.mockResolvedValue({
				state: 'stopped',
				reason: 'unsubscribed',
				source: 'local',
			})

			await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
				success: false,
				reason: 'stopped',
			})
			expect(mocks.inngestSend).not.toHaveBeenCalled()
			expect(mocks.log.info).toHaveBeenCalledWith(
				'skills.course.lesson_one_recovery_standing',
				{ state: 'stopped', reason: 'unsubscribed' },
			)
		})

		it('unknown: fails closed as a failed request', async () => {
			mocks.standing.mockResolvedValue({
				state: 'unknown',
				reason: 'drovr-stops-unreadable',
			})

			await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
				success: false,
				reason: 'request-failed',
			})
			expect(mocks.inngestSend).not.toHaveBeenCalled()
		})

		it('not found: not identified', async () => {
			mocks.standing.mockResolvedValue({
				state: 'not-found',
				reason: 'contact-not-found',
			})

			await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
				success: false,
				reason: 'not-identified',
			})
			expect(mocks.inngestSend).not.toHaveBeenCalled()
			expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(
				'learner@example.com',
			)
		})
	})
})
