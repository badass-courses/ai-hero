import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getServerAuthSession: vi.fn(),
	getSubscriberByEmail: vi.fn(),
	inngestSend: vi.fn(),
	log: { error: vi.fn() },
	readRecoveryToken: vi.fn(),
}))

vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {
		getSubscriberByEmail: mocks.getSubscriberByEmail,
	},
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
vi.mock('@/schemas/subscriber', () => ({
	SubscriberSchema: {
		safeParse: (value: unknown) =>
			value
				? { success: true, data: value }
				: { success: false, error: new Error('invalid subscriber') },
	},
}))
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
		mocks.getSubscriberByEmail.mockResolvedValue({
			id: 41,
			email_address: 'learner@example.com',
			state: 'active',
		})
		mocks.readRecoveryToken.mockResolvedValue({
			valid: false,
			reason: 'missing',
		})
		mocks.inngestSend.mockResolvedValue({ ids: ['event-1'] })
		mocks.log.error.mockResolvedValue(undefined)
	})

	it('queues only after the server session email matches the provider subscriber', async () => {
		await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
			success: true,
		})

		expect(mocks.getSubscriberByEmail).toHaveBeenCalledWith(
			'learner@example.com',
		)
		expect(mocks.readRecoveryToken).not.toHaveBeenCalled()
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

	it('rejects a provider subscriber whose email does not match the session', async () => {
		mocks.getSubscriberByEmail.mockResolvedValue({
			id: 999,
			email_address: 'victim@example.com',
			state: 'active',
		})

		await expect(resendSkillsCourseLessonOne()).resolves.toEqual({
			success: false,
			reason: 'not-identified',
		})
		expect(mocks.inngestSend).not.toHaveBeenCalled()
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
		expect(mocks.getSubscriberByEmail).not.toHaveBeenCalled()
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
		expect(mocks.getSubscriberByEmail).not.toHaveBeenCalled()
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

	it('routes inactive authorized subscribers through confirmation', async () => {
		mocks.getSubscriberByEmail.mockResolvedValue({
			id: 41,
			email_address: 'learner@example.com',
			state: 'inactive',
		})

		await expect(resendSkillsCourseLessonOne()).resolves.toMatchObject({
			success: false,
			reason: 'confirmation-required',
		})
		expect(mocks.inngestSend).not.toHaveBeenCalled()
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
})
