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

import {
	drovrEventsDeliver,
	drovrEventsDeliverBulk,
} from './drovr-events-deliver'

type Registered = {
	config: {
		id: string
		concurrency: Array<{ key?: string; limit: number }>
		batchEvents?: { maxSize: number; timeout: string }
	}
	trigger: { event: string }
}

const registered = drovrEventsDeliver as unknown as Registered
const registeredBulk = drovrEventsDeliverBulk as unknown as Registered

describe('drovr events deliver registration', () => {
	it('keeps the live function to one plain eight-slot queue', () => {
		// A per-source key (#260) capped a source's slots but not its place
		// in line: on 2026-09-21 a Kit page's thousand deliveries still held
		// every live fact Scheduled for two hours. Bulk sources now have their
		// own function; the key had nothing left to do.
		expect(registered.config.id).toBe('drovr-events-deliver-v1')
		expect(registered.config.concurrency).toEqual([{ limit: 8 }])
		expect(registered.trigger).toEqual({ event: 'drovr/events.deliver' })
	})

	it('runs bulk batches on their own function so they never share the live queue', () => {
		// 2026-09-21 04:44Z: with the key above, a Kit page's thousand
		// one-contact deliveries still sat ahead of the live and completion
		// lanes in the one function queue for eleven minutes. A separate
		// function is a separate queue.
		expect(registeredBulk.config.id).toBe('drovr-events-deliver-bulk-v1')
		expect(registeredBulk.config.concurrency).toEqual([{ limit: 4 }])
		expect(registeredBulk.trigger).toEqual({
			event: 'drovr/events.deliver.bulk',
		})
	})

	it('folds a bulk flood into hundred-event runs before it is queued', () => {
		// A Kit page is about a thousand one-contact events in one second.
		// As a thousand runs they are a thousand queue items and a thousand
		// owner lookups; as ten runs they are ten of each.
		expect(registeredBulk.config.batchEvents).toEqual({
			maxSize: 100,
			timeout: '10s',
		})
		expect(registered.config.batchEvents).toBeUndefined()
	})
})
