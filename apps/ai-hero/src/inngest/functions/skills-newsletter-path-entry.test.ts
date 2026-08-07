import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	enterSkillsNewsletterSubscriber: vi.fn(),
	readActiveGateDRuntimeAllowlist: vi.fn(),
	subscribeToList: vi.fn(),
	log: {
		info: vi.fn(),
		warn: vi.fn(),
	},
}))

vi.mock('@/db', () => ({ db: {} }))

vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {
		subscribeToList: mocks.subscribeToList,
	},
}))

vi.mock('@/inngest/events/skills-newsletter', () => ({
	SKILLS_NEWSLETTER_SUBSCRIBED_EVENT: 'skills-newsletter/subscribed',
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: vi.fn(
			(_config: unknown, _trigger: unknown, handler: unknown) => ({ handler }),
		),
	},
}))

vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {},
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

import { ConvertKitApiError } from '@coursebuilder/core/providers/convertkit'

import { skillsNewsletterPathEntry } from './skills-newsletter-path-entry'

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
	step: {
		run: (
			id: string,
			callback: () => Promise<unknown>,
		) => Promise<unknown>
	}
}) => Promise<unknown>

const handler = (
	skillsNewsletterPathEntry as unknown as { handler: TestHandler }
).handler

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

function createStep() {
	const results = new Map<string, unknown>()
	return {
		results,
		step: {
			run: vi.fn(async (id: string, callback: () => Promise<unknown>) => {
				const result = await callback()
				results.set(id, result)
				return result
			}),
		},
	}
}

function convertKitError(status: number) {
	return new ConvertKitApiError({
		message: `Kit request failed with ${status}`,
		status,
		statusText: 'Error',
		bodySnippet: '',
		responseHeaders: {},
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
		mocks.subscribeToList.mockResolvedValue({})
	})

	it('tags the subscriber for backfill when sequence subscription returns 400', async () => {
		mocks.subscribeToList.mockRejectedValueOnce(convertKitError(400))
		const { step, results } = createStep()

		await handler({ event, step })

		expect(mocks.subscribeToList).toHaveBeenNthCalledWith(1, {
			listId: '2625552',
			listType: 'sequence',
			user: { email: 'learner@example.com', name: 'Learner' },
			fields: {},
		})
		expect(mocks.subscribeToList).toHaveBeenNthCalledWith(2, {
			listId: '22309615',
			listType: 'tag',
			user: { email: 'learner@example.com', name: 'Learner' },
			fields: {},
		})
		expect(results.get('subscribe-to-shadow-newsletter')).toEqual({
			status: 'deferred',
		})
		expect(mocks.log.info).toHaveBeenCalledWith(
			'subscriber_funnel.shadow_newsletter_deferred',
			{
				funnel: 'skills-newsletter',
				eventId: 'event_1',
				contactId: 'contact_1',
				kitSequenceId: '2625552',
				kitBackfillTagId: '22309615',
			},
		)
	})

	it('rethrows non-400 ConvertKit errors', async () => {
		const error = convertKitError(500)
		mocks.subscribeToList.mockRejectedValueOnce(error)
		const { step } = createStep()

		await expect(handler({ event, step })).rejects.toBe(error)
		expect(mocks.subscribeToList).toHaveBeenCalledTimes(1)
	})

	it('rethrows errors from outside the ConvertKit API', async () => {
		const error = new Error('network unavailable')
		mocks.subscribeToList.mockRejectedValueOnce(error)
		const { step } = createStep()

		await expect(handler({ event, step })).rejects.toBe(error)
		expect(mocks.subscribeToList).toHaveBeenCalledTimes(1)
	})
})
