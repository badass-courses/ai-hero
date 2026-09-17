import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	buildPersonalization: vi.fn(),
	findContactById: vi.fn(),
	findProviderIdentity: vi.fn(),
	findValuePathEmailSideEffectIntentsByContact: vi.fn(),
	getAnswerPages: vi.fn(),
	log: {
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
	readDelivery: vi.fn(),
	sendDelivery: vi.fn(),
}))

vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/env.mjs', () => ({
	env: {
		NEXT_PUBLIC_SITE_TITLE: 'AI Hero',
		NEXT_PUBLIC_SUPPORT_EMAIL: 'support@aihero.dev',
	},
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: vi.fn(
			(config: unknown, _trigger: unknown, handler: unknown) => ({
				config,
				handler,
			}),
		),
	},
}))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {
		findContactById = mocks.findContactById
		findProviderIdentity = mocks.findProviderIdentity
		findValuePathEmailSideEffectIntentsByContact =
			mocks.findValuePathEmailSideEffectIntentsByContact
	},
}))
vi.mock('@/lib/subscriber-marketing/skills-course-recovery-delivery', () => ({
	readSkillsCourseRecoveryDelivery: mocks.readDelivery,
	sendSkillsCourseRecoveryDelivery: mocks.sendDelivery,
}))
vi.mock('@/lib/subscriber-marketing/value-path-answer-page', () => ({
	getValuePathAnswerPages: mocks.getAnswerPages,
}))
vi.mock('@/lib/subscriber-marketing/value-path-email-executor', () => ({
	buildValuePathEmailPersonalization: mocks.buildPersonalization,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { RetryAfterError } from 'inngest'

import {
	SKILLS_COURSE_RECOVERY_DELIVERY_RETRY_MS,
	SKILLS_COURSE_RECOVERY_IDENTITY_RETRY_MS,
	SKILLS_COURSE_RECOVERY_RETRIES,
	skillsCourseLessonOneRecovery,
} from './skills-course-lesson-one-recovery'

type TestEvent = {
	id: string
	name: 'skills-course/lesson-one-recovery.requested'
	data: {
		requestId: string
		recoveryKey: string
		requestedAt: string
		kitSubscriberId: string
		source: 'authenticated-session' | 'signed-recovery-token'
	}
}

type TestHandler = (args: {
	event: TestEvent
	step: {
		run: (id: string, callback: () => Promise<unknown>) => Promise<any>
	}
}) => Promise<unknown>

const fn = skillsCourseLessonOneRecovery as unknown as {
	config: {
		idempotency: string
		retries: number
		concurrency: number
		onFailure: (args: {
			event: { data: { event: TestEvent } }
			error: Error
		}) => Promise<void>
	}
	handler: TestHandler
}

const event: TestEvent = {
	id: 'recovery-event-1',
	name: 'skills-course/lesson-one-recovery.requested',
	data: {
		requestId: 'request-safe-1',
		recoveryKey: 'opaque-recovery-key',
		requestedAt: '2026-08-20T12:00:00.000Z',
		kitSubscriberId: 'kit-private-41',
		source: 'authenticated-session',
	},
}

function canonicalIntent(args: {
	completedAt?: string | null
	metadataCompletedAt?: string
	status?: 'pending' | 'completed' | 'failed'
}) {
	return {
		status: args.status ?? 'completed',
		completedAt: args.completedAt,
		metadata: {
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-0',
			...(args.metadataCompletedAt
				? { completedAt: args.metadataCompletedAt }
				: {}),
		},
	}
}

function createDurableStep() {
	const results = new Map<string, unknown>()
	return {
		results,
		step: {
			run: vi.fn(async (id: string, callback: () => Promise<unknown>) => {
				if (results.has(id)) return results.get(id)
				const result = await callback()
				results.set(id, result)
				return result
			}),
		},
	}
}

describe('skills course lesson-one recovery', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET = 'test-secret'
		process.env.NEXT_PUBLIC_URL = 'https://www.aihero.dev'
		process.env.POSTMARK_API_KEY = 'postmark-test-token'
		mocks.findProviderIdentity.mockResolvedValue({
			contactId: 'contact-private-41',
		})
		mocks.findContactById.mockResolvedValue({
			id: 'contact-private-41',
			email: 'learner@example.com',
			name: 'Learner',
		})
		mocks.findValuePathEmailSideEffectIntentsByContact.mockResolvedValue([
			canonicalIntent({ completedAt: '2026-08-20T10:00:00.000Z' }),
		])
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
		mocks.readDelivery.mockResolvedValue({ found: false })
		mocks.sendDelivery.mockResolvedValue({ messageId: 'message-1' })
		mocks.log.error.mockResolvedValue(undefined)
		mocks.log.info.mockResolvedValue(undefined)
		mocks.log.warn.mockResolvedValue(undefined)
	})

	it('deduplicates recovery by the opaque authorized identity key', () => {
		expect(fn.config).toMatchObject({
			idempotency: 'event.data.recoveryKey',
			retries: SKILLS_COURSE_RECOVERY_RETRIES,
			concurrency: 1,
		})
	})

	it('waits for Contact creation before the send step can run', async () => {
		mocks.findProviderIdentity.mockResolvedValueOnce(undefined)
		const { step } = createDurableStep()

		const firstAttempt = await fn
			.handler({ event, step })
			.catch((error) => error)
		expect(firstAttempt).toBeInstanceOf(RetryAfterError)
		if (!(firstAttempt instanceof RetryAfterError)) throw firstAttempt
		expect(firstAttempt.retryAfter).toBe(
			String(SKILLS_COURSE_RECOVERY_IDENTITY_RETRY_MS / 1000),
		)
		expect(mocks.sendDelivery).not.toHaveBeenCalled()

		await expect(fn.handler({ event, step })).resolves.toMatchObject({
			success: true,
		})
		expect(mocks.sendDelivery).toHaveBeenCalledTimes(1)
	})

	it('uses the canonical completion timestamp to prove post-click delivery', async () => {
		mocks.findValuePathEmailSideEffectIntentsByContact.mockResolvedValue([
			canonicalIntent({ completedAt: '2026-08-20T12:01:00.000Z' }),
		])
		const { step } = createDurableStep()

		await expect(fn.handler({ event, step })).resolves.toMatchObject({
			outcome: 'canonical-send-completed',
		})
		expect(mocks.sendDelivery).not.toHaveBeenCalled()
	})

	it('uses migration metadata completion time to prove post-click delivery', async () => {
		mocks.findValuePathEmailSideEffectIntentsByContact.mockResolvedValue([
			canonicalIntent({
				completedAt: null,
				metadataCompletedAt: '2026-08-20T12:01:00.000Z',
			}),
		])
		const { step } = createDurableStep()

		await expect(fn.handler({ event, step })).resolves.toMatchObject({
			outcome: 'canonical-send-completed',
		})
		expect(mocks.sendDelivery).not.toHaveBeenCalled()
	})

	it('does not claim post-click delivery when completion time is missing', async () => {
		mocks.findValuePathEmailSideEffectIntentsByContact.mockResolvedValue([
			canonicalIntent({ completedAt: null }),
		])
		const { step } = createDurableStep()

		const result = await fn.handler({ event, step }).catch((error) => error)
		expect(result).toBeInstanceOf(RetryAfterError)
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'skills.course.lesson_one_recovery_retrying',
			{
				requestId: 'request-safe-1',
				reason: 'canonical-completion-unproven',
			},
		)
		expect(mocks.sendDelivery).not.toHaveBeenCalled()
	})

	it('sends a recovery when canonical completion predates the click', async () => {
		const { step } = createDurableStep()

		await expect(fn.handler({ event, step })).resolves.toMatchObject({
			success: true,
		})
		expect(mocks.readDelivery).toHaveBeenCalledWith({
			correlationId: 'request-safe-1',
			postmarkToken: 'postmark-test-token',
		})
		expect(mocks.sendDelivery).toHaveBeenCalledTimes(1)
	})

	it('reads provider correlation before replaying ambiguous acceptance', async () => {
		mocks.sendDelivery.mockRejectedValueOnce(
			new Error('timeout learner@example.com contact-private-41'),
		)
		mocks.readDelivery
			.mockResolvedValueOnce({ found: false })
			.mockResolvedValueOnce({ found: true, messageId: 'message-accepted' })
		const { step, results } = createDurableStep()

		const firstAttempt = await fn
			.handler({ event, step })
			.catch((error) => error)
		expect(firstAttempt).toBeInstanceOf(RetryAfterError)
		if (!(firstAttempt instanceof RetryAfterError)) throw firstAttempt
		expect(firstAttempt.retryAfter).toBe(
			String(SKILLS_COURSE_RECOVERY_DELIVERY_RETRY_MS / 1000),
		)

		await expect(fn.handler({ event, step })).resolves.toMatchObject({
			success: true,
		})
		expect(mocks.readDelivery).toHaveBeenCalledTimes(2)
		expect(mocks.sendDelivery).toHaveBeenCalledTimes(1)
		expect(results.get('send-lesson-one-recovery')).toMatchObject({
			via: 'readback',
			providerCorrelationId: 'request-safe-1',
			messageId: 'message-accepted',
		})

		await fn.handler({ event, step })
		expect(mocks.sendDelivery).toHaveBeenCalledTimes(1)
	})

	it('does not send when provider readback fails', async () => {
		mocks.readDelivery.mockRejectedValue(
			new Error('readback failed learner@example.com'),
		)
		const { step } = createDurableStep()

		const result = await fn.handler({ event, step }).catch((error) => error)
		expect(result).toBeInstanceOf(RetryAfterError)
		expect(mocks.sendDelivery).not.toHaveBeenCalled()
	})

	it('logs only the random request reference on retry and terminal failure', async () => {
		mocks.findProviderIdentity.mockResolvedValue(undefined)
		const { step } = createDurableStep()

		await fn.handler({ event, step }).catch(() => undefined)
		await fn.config.onFailure({
			event: { data: { event } },
			error: new Error('learner@example.com kit-private-41 contact-private-41'),
		})

		const logs = JSON.stringify([
			...mocks.log.warn.mock.calls,
			...mocks.log.error.mock.calls,
		])
		expect(logs).toContain('request-safe-1')
		expect(logs).not.toContain('learner@example.com')
		expect(logs).not.toContain('kit-private-41')
		expect(logs).not.toContain('contact-private-41')
	})

	it('never enrolls a Kit sequence while sending the transactional recovery', async () => {
		const { step } = createDurableStep()

		await fn.handler({ event, step })

		expect(mocks.sendDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				correlationId: 'request-safe-1',
				to: 'learner@example.com',
			}),
		)
	})
})
