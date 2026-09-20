import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DrovrShadowEvent } from '@/lib/subscriber-marketing/drovr-shadow-emitter'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn(),
	deliverOrThrow: vi.fn(),
	deliveryStepId: vi.fn((event: { idempotencyKey: string }) =>
		`deliver:${event.idempotencyKey}`,
	),
	resolveOwnedContactIds: vi.fn(),
	log: {
		warn: vi.fn(),
	},
}))

vi.mock('@/env.mjs', () => ({
	env: {
		DROVR_SHADOW_INGEST_URL: 'https://drovr.test/events',
		DROVR_SHADOW_API_KEY: 'shadow-key',
		DROVR_API_KEY_ORG_AIHERO: 'authority-key',
	},
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: mocks.createFunction.mockImplementation(
			(config: unknown, trigger: unknown, handler: unknown) => ({
				config,
				trigger,
				handler,
			}),
		),
	},
}))

vi.mock('@/lib/subscriber-marketing/drovr-shadow-delivery', () => ({
	deliverOrThrow: mocks.deliverOrThrow,
	deliveryStepId: mocks.deliveryStepId,
}))

vi.mock('@/lib/subscriber-marketing/drovr-ownership-live', () => ({
	resolveOwnedContactIds: mocks.resolveOwnedContactIds,
}))

vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { drovrEventsDeliver } from './drovr-events-deliver'

type TestHandler = (args: {
	event: {
		data: {
			events: readonly DrovrShadowEvent[]
			source: string
		}
	}
	step: {
		run: (id: string, callback: () => Promise<unknown>) => Promise<unknown>
	}
}) => Promise<unknown>

const handler = (drovrEventsDeliver as unknown as { handler: TestHandler }).handler

const birth: DrovrShadowEvent = {
	tenantId: 'org-aihero-shadow',
	contactId: 'contact-1',
	journeyId: 'shadow-newsletter',
	type: 'contact.created',
	occurredAt: '2026-09-20T05:00:00.000Z',
	idempotencyKey:
		'contact:org-aihero-shadow:contact-1:shadow-newsletter:birth',
	payload: {
		timezone: 'America/Los_Angeles',
		timezoneSource: 'fallback',
	},
}

function createStep() {
	return {
		run: vi.fn(async (_id: string, callback: () => Promise<unknown>) =>
			callback(),
		),
	}
}

function event() {
	return {
		data: {
			events: [birth],
			source: 'course-exhausted',
		},
	}
}

describe('drovrEventsDeliver newsletter ownership gate', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.deliverOrThrow.mockResolvedValue({ status: 'accepted' })
	})

	it('drops a birth when only the skills-course assignment exists', async () => {
		mocks.resolveOwnedContactIds
			.mockResolvedValueOnce(['contact-1'])
			.mockResolvedValueOnce([])

		await expect(handler({ event: event(), step: createStep() })).resolves.toEqual(
			{
				status: 'delivered',
				accepted: 0,
				rejected: 0,
			},
		)

		expect(mocks.resolveOwnedContactIds).toHaveBeenNthCalledWith(
			2,
			[birth],
			{ journeyId: 'shadow-newsletter' },
		)
		expect(mocks.deliverOrThrow).not.toHaveBeenCalled()
	})

	it('keeps the birth and authority copy when the newsletter assignment exists', async () => {
		mocks.resolveOwnedContactIds
			.mockResolvedValueOnce(['contact-1'])
			.mockResolvedValueOnce(['contact-1'])

		await handler({ event: event(), step: createStep() })

		expect(mocks.deliverOrThrow).toHaveBeenCalledTimes(2)
		expect(
			mocks.deliverOrThrow.mock.calls.map(
				([args]: [{ event: DrovrShadowEvent }]) => args.event,
			),
		).toEqual([
			birth,
			{
				...birth,
				tenantId: 'org-aihero',
				idempotencyKey: `owner:${birth.idempotencyKey}`,
			},
		])
		expect(mocks.resolveOwnedContactIds).toHaveBeenNthCalledWith(
			2,
			[birth],
			{ journeyId: 'shadow-newsletter' },
		)
	})
})
