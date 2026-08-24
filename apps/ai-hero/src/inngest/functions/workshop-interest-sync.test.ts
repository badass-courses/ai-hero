import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	subscribeToList: vi.fn(),
	tagSubscriber: vi.fn(),
	createFunction: vi.fn(),
	log: {
		info: vi.fn(),
		error: vi.fn(),
	},
}))

vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {
		subscribeToList: mocks.subscribeToList,
		tagSubscriber: mocks.tagSubscriber,
	},
}))

vi.mock('@/env.mjs', () => ({
	env: { CONVERTKIT_SIGNUP_FORM: 'signup-form' },
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: mocks.createFunction.mockImplementation(
			(config: unknown, _trigger: unknown, handler: unknown) => ({
				config,
				handler,
			}),
		),
	},
}))

vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { workshopInterestSync } from './workshop-interest-sync'

type TestEvent = {
	name: 'workshop/interest.requested'
	data: {
		email: string
		name?: string
		workshopSlug: string
		surface: 'post-closing'
		expressedAt: string
		via: 'cookie'
		subscriberId?: number
	}
}

type TestHandler = (args: {
	event: TestEvent
	step: {
		run: (id: string, callback: () => Promise<unknown>) => Promise<unknown>
	}
}) => Promise<unknown>

const fn = workshopInterestSync as unknown as {
	config: {
		idempotency: string
		retries: number
		throttle: { limit: number; period: string }
		onFailure: (args: {
			event: { data: { event: TestEvent } }
			error: Error
		}) => Promise<void>
	}
	handler: TestHandler
}

const event: TestEvent = {
	name: 'workshop/interest.requested',
	data: {
		email: 'reader@example.com',
		name: 'Reader',
		workshopSlug: 'ai-coding-crash-course',
		surface: 'post-closing',
		expressedAt: '2026-08-08T12:34:56.000Z',
		via: 'cookie',
		subscriberId: 42,
	},
}

function createStep() {
	return {
		run: vi.fn(async (_id: string, callback: () => Promise<unknown>) =>
			callback(),
		),
	}
}

describe('workshopInterestSync', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.subscribeToList.mockResolvedValue({ id: 42 })
		mocks.tagSubscriber.mockResolvedValue(undefined)
		mocks.log.info.mockResolvedValue(undefined)
		mocks.log.error.mockResolvedValue(undefined)
	})

	it('uses email plus workshop as its idempotency key and throttles Kit writes', () => {
		expect(fn.config).toMatchObject({
			idempotency: 'event.data.email + ":" + event.data.workshopSlug',
			retries: 5,
			throttle: { limit: 4, period: '1s' },
		})
	})

	it('writes the canonical dated field, source, and matching tag', async () => {
		await expect(fn.handler({ event, step: createStep() })).resolves.toEqual({
			success: true,
			intentKey: 'interest:workshop:ai_coding_crash_course',
		})
		expect(mocks.subscribeToList).toHaveBeenCalledWith({
			listId: 'signup-form',
			listType: 'form',
			user: { email: 'reader@example.com', name: 'Reader' },
			fields: {
				interest_ai_coding_crash_course: '2026-08-08',
				source: 'aihero_post_closing',
			},
		})
		expect(mocks.tagSubscriber).toHaveBeenCalledWith({
			tag: 'interest_ai_coding_crash_course',
			email: 'reader@example.com',
		})
		expect(mocks.log.info).toHaveBeenCalledWith(
			'workshop.interest.success',
			expect.objectContaining({ phase: 'terminal-sync' }),
		)
	})

	it('logs a terminal failure after Inngest exhausts retries', async () => {
		await fn.config.onFailure({
			event: { data: { event } },
			error: new Error('Kit still rate limited'),
		})

		expect(mocks.log.error).toHaveBeenCalledWith(
			'workshop.interest.failed',
			expect.objectContaining({
				workshopSlug: 'ai-coding-crash-course',
				phase: 'terminal-sync',
				error: 'Kit still rate limited',
			}),
		)
	})
})
