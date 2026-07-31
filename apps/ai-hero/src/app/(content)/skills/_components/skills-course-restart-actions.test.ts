import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	buildPersonalization: vi.fn(),
	findContactByEmail: vi.fn(),
	getAnswerPages: vi.fn(),
	getSubscriberByEmail: vi.fn(),
	log: { info: vi.fn(), error: vi.fn() },
	reconcile: vi.fn(),
	resolveIdentity: vi.fn(),
	sendAnEmail: vi.fn(),
}))

vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {
		getSubscriberByEmail: mocks.getSubscriberByEmail,
	},
}))

vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/emails/basic-email', () => ({ default: vi.fn() }))
vi.mock('@/env.mjs', () => ({
	env: {
		NEXT_PUBLIC_SITE_TITLE: 'AI Hero',
		NEXT_PUBLIC_SUPPORT_EMAIL: 'support@aihero.dev',
	},
}))
vi.mock('@/lib/enrolment-identity', () => ({
	resolveEnrolmentIdentity: mocks.resolveIdentity,
}))
vi.mock('@/lib/subscriber-marketing/ai-hero-email-opt-in.server', () => ({
	reconcileAiHeroEmailOptInWithKit: mocks.reconcile,
}))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {
		findContactByEmail = mocks.findContactByEmail
	},
}))
vi.mock('@/lib/subscriber-marketing/value-path-answer-page', () => ({
	getValuePathAnswerPages: mocks.getAnswerPages,
}))
vi.mock('@/lib/subscriber-marketing/value-path-email-executor', () => ({
	buildValuePathEmailPersonalization: mocks.buildPersonalization,
}))
vi.mock('@/schemas/subscriber', () => ({
	SubscriberSchema: { parse: (value: unknown) => value },
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@coursebuilder/utils/send-an-email', () => ({
	sendAnEmail: mocks.sendAnEmail,
}))

import { resendSkillsCourseLessonOne } from './skills-course-restart-actions'

describe('resendSkillsCourseLessonOne', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET = 'test-secret'
		process.env.NEXT_PUBLIC_URL = 'https://www.aihero.dev'
		mocks.resolveIdentity.mockResolvedValue({
			identity: {
				email: 'learner@example.com',
				name: 'Learner',
				via: 'cookie',
			},
			subscriber: { id: 41, email_address: 'learner@example.com' },
		})
		mocks.getSubscriberByEmail.mockResolvedValue({
			id: 41,
			email_address: 'learner@example.com',
			state: 'active',
			fields: {},
		})
		mocks.reconcile.mockResolvedValue({ status: 'active' })
		mocks.findContactByEmail.mockResolvedValue({ id: 'contact-41' })
		mocks.getAnswerPages.mockResolvedValue([])
		mocks.buildPersonalization.mockReturnValue({
			passed: true,
			fields: {
				aih_value_path_answer_links_json: JSON.stringify([
					{ optionValue: 'personal', href: 'https://aih.test/personal' },
					{ optionValue: 'team', href: 'https://aih.test/team' },
					{ optionValue: 'unsure', href: 'https://aih.test/unsure' },
				]),
			},
		})
		mocks.sendAnEmail.mockResolvedValue({ MessageID: 'message-1' })
	})

	it('sends one transactional lesson without touching a Kit sequence', async () => {
		const result = await resendSkillsCourseLessonOne('skills_hero_recovery')

		expect(result).toEqual({ success: true })
		expect(mocks.sendAnEmail).toHaveBeenCalledTimes(1)
		expect(mocks.sendAnEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				To: 'learner@example.com',
				type: 'transactional',
				componentProps: expect.objectContaining({
					body: expect.stringContaining('https://aih.test/personal'),
				}),
			}),
		)
		expect(mocks.getSubscriberByEmail).toHaveBeenCalledTimes(1)
	})

	it('uses the same development signing secret as the answer page', async () => {
		delete process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET

		const result = await resendSkillsCourseLessonOne()

		expect(result).toEqual({ success: true })
		expect(mocks.buildPersonalization).toHaveBeenCalledWith(
			expect.objectContaining({
				pathTokenSecret: 'dev-value-path-token-secret',
			}),
		)
	})

	it('redirects an inactive subscriber through Kit confirmation', async () => {
		mocks.reconcile.mockResolvedValue({ status: 'confirmation-required' })

		const result = await resendSkillsCourseLessonOne()

		expect(result).toMatchObject({
			success: false,
			reason: 'confirmation-required',
		})
		expect(mocks.sendAnEmail).not.toHaveBeenCalled()
	})

	it('does not claim success when the email provider rejects the resend', async () => {
		mocks.sendAnEmail.mockResolvedValue({ ErrorCode: 406 })

		const result = await resendSkillsCourseLessonOne()

		expect(result).toEqual({ success: false, reason: 'request-failed' })
		expect(mocks.log.error).toHaveBeenCalledWith(
			'skills.course.lesson_one_resend_failed',
			expect.objectContaining({ error: 'Postmark rejected lesson one: 406' }),
		)
	})
})
