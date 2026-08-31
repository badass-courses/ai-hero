import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findIntent: vi.fn(),
	findSelectedEvent: vi.fn(),
	getAnswerPages: vi.fn(),
	observeAnswer: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/db', () => ({
	db: {
		query: {
			contactEvent: { findFirst: mocks.findSelectedEvent },
		},
	},
}))

vi.mock('@/db/schema', () => ({
	contactEvent: { id: 'contact-event-id' },
}))

vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => 'where-contact-event') }))

vi.mock('@/inngest/events/value-path', () => ({
	VALUE_PATH_ANSWER_SELECTED_EVENT: 'value-path/answer.selected',
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
		findSideEffectIntentByIdempotencyKey = mocks.findIntent
	},
}))

vi.mock('@/lib/subscriber-marketing/email-course-shadow-runtime', () => ({
	createEmailCourseShadowRuntime: () => ({
		observeAnswer: mocks.observeAnswer,
	}),
}))

vi.mock('@/lib/subscriber-marketing/value-path-answer-page', () => ({
	getValuePathAnswerPages: mocks.getAnswerPages,
}))

vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { emailCourseShadowAnswer } from './email-course-shadow-answer'

const fn = emailCourseShadowAnswer as unknown as {
	handler: (args: {
		event: {
			data: {
				contactId: string
				valuePathSlug: string
				sentEmailResourceId: string
				answerPageId: string
				contactEventId: string
			}
		}
		step: {
			run: (id: string, callback: () => Promise<unknown>) => Promise<any>
		}
	}) => Promise<unknown>
}

const event = {
	data: {
		contactId: 'contact-1',
		valuePathSlug: 'ai-hero-skills-workflow',
		sentEmailResourceId: 'ai-hero-skills-workflow.email-0',
		answerPageId: 'answer-page-1',
		contactEventId: 'answer-event-1',
	},
}

const step = {
	run: vi.fn(async (_id: string, callback: () => Promise<unknown>) =>
		callback(),
	),
}

describe('Email Course shadow answer caller', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.findIntent.mockResolvedValue({
			metadata: { courseEntryEventId: 'entry-event-1' },
		})
		mocks.findSelectedEvent.mockResolvedValue({
			occurredAt: new Date('2026-09-01T16:00:00.000Z'),
		})
		mocks.getAnswerPages.mockResolvedValue([
			{
				id: 'answer-page-1',
				fields: {
					nextEmailResourceId: 'ai-hero-skills-workflow.email-1',
				},
			},
		])
		mocks.observeAnswer.mockResolvedValue({ status: 'committed' })
	})

	it('observes the committed production answer without changing it', async () => {
		const result = await fn.handler({ event, step })

		expect(result).toEqual({ status: 'committed' })
		expect(mocks.observeAnswer).toHaveBeenCalledWith({
			courseEntryEventId: 'entry-event-1',
			contactEventId: 'answer-event-1',
			sentEmailResourceId: 'ai-hero-skills-workflow.email-0',
			selectedNextEmailResourceId: 'ai-hero-skills-workflow.email-1',
			selectedAt: '2026-09-01T16:00:00.000Z',
		})
	})

	it('skips safely when the production entry binding is absent', async () => {
		mocks.findIntent.mockResolvedValue(undefined)

		const result = await fn.handler({ event, step })

		expect(result).toEqual({
			status: 'skipped',
			reason: 'legacy-answer-shadow-context-missing',
		})
		expect(mocks.observeAnswer).not.toHaveBeenCalled()
	})
})
