import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn((options, trigger, handler) => ({
		options,
		trigger,
		handler,
	})),
}))

vi.mock('@/db', () => ({ courseBuilderAdapter: {}, db: {} }))
vi.mock('@/emails/welcome-email', () => ({
	default: vi.fn(),
	WelcomeEmailForTeam: vi.fn(),
}))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/lib/events-query', () => ({ getEventOrEventSeries: vi.fn() }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@coursebuilder/utils/send-an-email', () => ({ sendAnEmail: vi.fn() }))

import './send-live-event-welcome-email'

// Captured at import time: the config may clear mock calls between tests.
const [, trigger] = mocks.createFunction.mock.calls[0]!

describe('send-live-event-welcome-email trigger', () => {
	it('listens to new purchases of live products only', () => {
		expect(trigger).toEqual({
			event: 'commerce/new-purchase-created',
			if: 'event.data.productType == "live"',
		})
	})
})
