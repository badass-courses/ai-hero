import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	enterSkillsNewsletterSubscriber: vi.fn(),
	shadowObserveSignup: vi.fn(),
	readActiveGateDRuntimeAllowlist: vi.fn(),
	subscribeToKitListWithoutFields: vi.fn(),
	log: {
		info: vi.fn(),
		warn: vi.fn(),
	},
}))

vi.mock('@/db', () => ({ db: {} }))

vi.mock('@/coursebuilder/email-list-provider', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('@/coursebuilder/email-list-provider')>()
	return {
		...actual,
		emailListProvider: { subscribeToList: vi.fn() },
		subscribeToKitListWithoutFields: mocks.subscribeToKitListWithoutFields,
	}
})

vi.mock('@/inngest/events/skills-newsletter', () => ({
	SKILLS_NEWSLETTER_SUBSCRIBED_EVENT: 'skills-newsletter/subscribed',
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
	DrizzleCaptureMarketingRepository: class {},
}))

vi.mock('@/lib/subscriber-marketing/email-course-shadow-runtime', () => ({
	createEmailCourseShadowRuntime: () => ({
		observeSignup: mocks.shadowObserveSignup,
	}),
}))

vi.mock('@/lib/subscriber-marketing/skills-newsletter-path-entry', () => ({
	enterSkillsNewsletterSubscriber: mocks.enterSkillsNewsletterSubscriber,
	SHADOW_NEWSLETTER_BACKFILL_KIT_TAG: '22309615',
	SHADOW_NEWSLETTER_KIT_SEQUENCE: '2625552',
}))

vi.mock('@/lib/subscriber-marketing/value-path-gate-d-allowlist', () => ({
	readActiveGateDRuntimeAllowlist: mocks.readActiveGateDRuntimeAllowlist,
}))

vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/redis-client', () => ({ redis: {} }))

import { KitSubscribeError } from '@/coursebuilder/email-list-provider'
import { KIT_RATE_LIMIT_DELAY_MS } from '@/coursebuilder/kit-write-retry'

import { ConvertKitApiError } from '@coursebuilder/core/providers/convertkit'
import { NonRetriableError, RetryAfterError } from 'inngest'

import {
	PAUSED_SEQUENCE_MAX_PROVIDER_CALLS,
	SKILLS_NEWSLETTER_PATH_RETRIES,
	skillsNewsletterPathEntry,
} from './skills-newsletter-path-entry'

type TestEvent = {
	id: string
	data: {
		kitSubscriberId: string
		email: string
		name: string
		formId: number
		source: string
		subscribedAt: string
	}
}

type TestHandler = (args: {
	event: TestEvent
	attempt: number
	maxAttempts: number
	step: {
		run: (id: string, callback: () => Promise<unknown>) => Promise<any>
	}
}) => Promise<unknown>

const fn = skillsNewsletterPathEntry as unknown as {
	config: {
		retries: number
		concurrency: number
		throttle: { limit: number; period: string }
	}
	handler: TestHandler
}
const handler = fn.handler

const event: TestEvent = {
	id: 'event_1',
	data: {
		kitSubscriberId: 'kit_1',
		email: 'learner@example.com',
		name: 'Learner',
		formId: 9376133,
		source: 'test',
		subscribedAt: '2026-08-07T12:00:00.000Z',
	},
}

class DurableStepCompleted extends Error {}

function createDurableStep({
	yieldAfterSuccess = new Set<string>(),
}: {
	yieldAfterSuccess?: Set<string>
} = {}) {
	const results = new Map<string, unknown>()
	return {
		results,
		step: {
			run: vi.fn(async (id: string, callback: () => Promise<unknown>) => {
				if (results.has(id)) return results.get(id)
				const result = await callback()
				results.set(id, result)
				if (yieldAfterSuccess.has(id)) throw new DurableStepCompleted()
				return result
			}),
		},
	}
}

function convertKitError(
	status: number,
	responseHeaders: Record<string, string> = {},
) {
	return new ConvertKitApiError({
		message: `Kit request failed with ${status}`,
		status,
		statusText: 'Error',
		bodySnippet: '',
		responseHeaders,
	})
}

async function runAttempt(
	step: ReturnType<typeof createDurableStep>['step'],
	attempt: number,
) {
	return handler({
		event,
		step,
		attempt,
		maxAttempts: SKILLS_NEWSLETTER_PATH_RETRIES + 1,
	})
}

describe('skills newsletter path entry', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.readActiveGateDRuntimeAllowlist.mockResolvedValue({
			passed: true,
			allowlist: { authorizationMode: 'rolling-public-enrollment' },
			reviewReasons: [],
		})
		mocks.enterSkillsNewsletterSubscriber.mockResolvedValue({
			status: 'planned',
			contactId: 'contact_1',
			captureEventId: 'capture_1',
			entry: {
				counts: {
					planned: 1,
					blocked: 0,
					idempotentNoop: 0,
				},
				results: [],
			},
		})
		mocks.subscribeToKitListWithoutFields.mockResolvedValue({})
		vi.spyOn(Math, 'random').mockReturnValue(0)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('states the independent-step worst-case provider-call bound', () => {
		expect(fn.config).toMatchObject({
			retries: 3,
			concurrency: 1,
			throttle: { limit: 1, period: '2s' },
		})
		expect(PAUSED_SEQUENCE_MAX_PROVIDER_CALLS).toBe(2 * (fn.config.retries + 1))
	})

	it('passes the isolated shadow observer beside the production entry', async () => {
		const { step } = createDurableStep()

		await runAttempt(step, 0)

		expect(mocks.enterSkillsNewsletterSubscriber).toHaveBeenCalledWith(
			expect.objectContaining({
				shadowObserver: mocks.shadowObserveSignup,
				allowWrite: true,
			}),
		)
	})

	it('persists the sequence probe before running the fallback tag step', async () => {
		mocks.subscribeToKitListWithoutFields.mockRejectedValueOnce(
			convertKitError(400),
		)
		const { step, results } = createDurableStep()

		await runAttempt(step, 0)

		expect(mocks.subscribeToKitListWithoutFields).toHaveBeenNthCalledWith(1, {
			listId: '2625552',
			listType: 'sequence',
			user: { email: 'learner@example.com', name: 'Learner' },
		})
		expect(mocks.subscribeToKitListWithoutFields).toHaveBeenNthCalledWith(2, {
			listId: '22309615',
			listType: 'tag',
			user: { email: 'learner@example.com', name: 'Learner' },
		})
		expect(results.get('probe-shadow-newsletter-sequence')).toEqual({
			status: 'deferred',
		})
		expect(results.get('tag-shadow-newsletter-backfill')).toEqual({
			status: 'tagged',
		})
	})

	it('uses RetryAfterError instead of an in-process 429 retry', async () => {
		mocks.subscribeToKitListWithoutFields.mockRejectedValue(
			convertKitError(429),
		)
		const { step } = createDurableStep()

		const error = await runAttempt(step, 0).catch((cause) => cause)

		expect(error).toBeInstanceOf(RetryAfterError)
		if (!(error instanceof RetryAfterError)) throw error
		expect(error.retryAfter).toBe(String(KIT_RATE_LIMIT_DELAY_MS / 1_000))
		expect(mocks.subscribeToKitListWithoutFields).toHaveBeenCalledTimes(1)
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'kit.write.retry',
			expect.objectContaining({
				attempt: 1,
				delayMs: KIT_RATE_LIMIT_DELAY_MS,
				delaySource: 'rate-limit-window',
				providerCalls: 1,
			}),
		)
	})

	it('honors provider Retry-After through the durable retry error', async () => {
		mocks.subscribeToKitListWithoutFields.mockRejectedValue(
			convertKitError(429, { 'retry-after': '120' }),
		)
		const { step } = createDurableStep()

		const error = await runAttempt(step, 0).catch((cause) => cause)

		expect(error).toBeInstanceOf(RetryAfterError)
		if (!(error instanceof RetryAfterError)) throw error
		expect(error.retryAfter).toBe('120')
	})

	it('reuses the 400 probe when the durable tag retry recovers', async () => {
		mocks.subscribeToKitListWithoutFields
			.mockRejectedValueOnce(convertKitError(400))
			.mockRejectedValueOnce(convertKitError(429))
			.mockResolvedValueOnce({})
		const { step } = createDurableStep()

		await expect(runAttempt(step, 0)).rejects.toBeInstanceOf(RetryAfterError)
		await expect(runAttempt(step, 1)).resolves.toEqual(
			expect.objectContaining({ contactId: 'contact_1' }),
		)

		expect(mocks.subscribeToKitListWithoutFields).toHaveBeenCalledTimes(3)
		expect(
			mocks.subscribeToKitListWithoutFields.mock.calls.filter(
				([options]) => options.listType === 'sequence',
			),
		).toHaveLength(1)
		expect(mocks.log.info).toHaveBeenCalledWith(
			'kit.write.outcome',
			expect.objectContaining({
				operation: 'shadow-backfill-tag',
				outcome: 'recovered',
				attempts: 2,
			}),
		)
	})

	it('caps an immediate paused probe plus configured tag attempts', async () => {
		const persistent429 = convertKitError(429)
		mocks.subscribeToKitListWithoutFields
			.mockRejectedValueOnce(convertKitError(400))
			.mockRejectedValue(persistent429)
		const { step } = createDurableStep()
		const failures: unknown[] = []

		for (
			let attempt = 0;
			attempt <= SKILLS_NEWSLETTER_PATH_RETRIES;
			attempt++
		) {
			try {
				await runAttempt(step, attempt)
			} catch (error) {
				failures.push(error)
			}
		}

		expect(
			failures.slice(0, -1).every((error) => error instanceof RetryAfterError),
		).toBe(true)
		expect(failures.at(-1)).toBe(persistent429)
		expect(mocks.subscribeToKitListWithoutFields).toHaveBeenCalledTimes(
			1 + (SKILLS_NEWSLETTER_PATH_RETRIES + 1),
		)
		expect(
			mocks.subscribeToKitListWithoutFields.mock.calls.filter(
				([options]) => options.listType === 'sequence',
			),
		).toHaveLength(1)
		expect(
			mocks.subscribeToKitListWithoutFields.mock.calls.filter(
				([options]) => options.listType === 'tag',
			),
		).toHaveLength(SKILLS_NEWSLETTER_PATH_RETRIES + 1)
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'kit.write.outcome',
			expect.objectContaining({
				operation: 'shadow-backfill-tag',
				outcome: 'exhausted',
				attempts: 4,
				providerCalls: 1,
				maxProviderCallsForOperation: 4,
				maxProviderCallsForPausedEvent: 8,
			}),
		)
	})

	it('bounds sequence retries then 400 plus independent tag exhaustion', async () => {
		const persistent429 = convertKitError(429)
		let sequenceCalls = 0
		let tagCalls = 0
		mocks.subscribeToKitListWithoutFields.mockImplementation(
			async ({ listType }: { listType: 'sequence' | 'tag' }) => {
				if (listType === 'sequence') {
					sequenceCalls += 1
					throw sequenceCalls <= SKILLS_NEWSLETTER_PATH_RETRIES
						? convertKitError(429)
						: convertKitError(400)
				}
				tagCalls += 1
				throw persistent429
			},
		)
		const { step } = createDurableStep({
			yieldAfterSuccess: new Set(['probe-shadow-newsletter-sequence']),
		})
		const sequenceFailures: unknown[] = []
		const tagFailures: unknown[] = []

		for (let attempt = 0; attempt < SKILLS_NEWSLETTER_PATH_RETRIES; attempt++) {
			await runAttempt(step, attempt).catch((error) => {
				sequenceFailures.push(error)
			})
		}
		await expect(
			runAttempt(step, SKILLS_NEWSLETTER_PATH_RETRIES),
		).rejects.toBeInstanceOf(DurableStepCompleted)

		// Inngest resets the attempt counter when the completed sequence step gives
		// way to the independent fallback-tag step.
		for (
			let attempt = 0;
			attempt <= SKILLS_NEWSLETTER_PATH_RETRIES;
			attempt++
		) {
			await runAttempt(step, attempt).catch((error) => {
				tagFailures.push(error)
			})
		}

		expect(
			sequenceFailures.every((error) => error instanceof RetryAfterError),
		).toBe(true)
		expect(
			tagFailures
				.slice(0, -1)
				.every((error) => error instanceof RetryAfterError),
		).toBe(true)
		expect(tagFailures.at(-1)).toBe(persistent429)
		expect(sequenceCalls).toBe(SKILLS_NEWSLETTER_PATH_RETRIES + 1)
		expect(tagCalls).toBe(SKILLS_NEWSLETTER_PATH_RETRIES + 1)
		expect(mocks.subscribeToKitListWithoutFields).toHaveBeenCalledTimes(
			PAUSED_SEQUENCE_MAX_PROVIDER_CALLS,
		)
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'kit.write.outcome',
			expect.objectContaining({
				operation: 'shadow-backfill-tag',
				outcome: 'exhausted',
				attempts: 4,
				maxProviderCallsForOperation: 4,
				maxProviderCallsForPausedEvent: 8,
			}),
		)
	})

	it('does not retry a successful POST with an unresolved subscriber', async () => {
		mocks.subscribeToKitListWithoutFields.mockRejectedValue(
			new KitSubscribeError({ code: 'unresolved' }),
		)
		const { step } = createDurableStep()

		await expect(runAttempt(step, 0)).rejects.toBeInstanceOf(NonRetriableError)
		expect(mocks.subscribeToKitListWithoutFields).toHaveBeenCalledTimes(1)
	})
})
