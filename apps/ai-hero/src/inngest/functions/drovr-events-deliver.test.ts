import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn(
		(config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-delivery', () => ({
	deliverOrThrow: vi.fn(),
	deliveryStepId: vi.fn(),
}))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-emitter', () => ({
	drovrApiKeyForTenant: vi.fn(),
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID: 'shadow-newsletter',
}))
vi.mock('@/lib/subscriber-marketing/drovr-ownership', () => ({
	fanOutOwnedEvents: vi.fn(),
	isShadowNewsletterBirth: vi.fn(),
}))
vi.mock('@/lib/subscriber-marketing/drovr-ownership-live', () => ({
	resolveOwnedContactIds: vi.fn(),
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { drovrEventsDeliver } from './drovr-events-deliver'

const registered = drovrEventsDeliver as unknown as {
	config: {
		id: string
		concurrency: Array<{ key?: string; limit: number }>
	}
	trigger: { event: string }
}

describe('drovr events deliver registration', () => {
	it('keeps a per-source sub-queue so bulk producers cannot starve live facts', () => {
		// 2026-09-20: the Kit directory ingest emitted ~170 `contact-created`
		// facts a minute into a single 8-slot queue and live signups waited
		// minutes behind them. The keyed entry caps any one source at half
		// the slots and gives every other source its own queue.
		expect(registered.config.id).toBe('drovr-events-deliver-v1')
		expect(registered.config.concurrency).toEqual([
			{ limit: 8 },
			{ key: 'event.data.source', limit: 4 },
		])
		expect(registered.trigger).toEqual({ event: 'drovr/events.deliver' })
	})
})
