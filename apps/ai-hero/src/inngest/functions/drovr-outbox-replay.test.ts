import { describe, expect, it, vi } from 'vitest'

vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: vi.fn((config: unknown, trigger: unknown) => ({
			config,
			trigger,
		})),
	},
}))

import { drovrOutboxReplay } from './drovr-outbox-replay'

describe('drovr-outbox-replay-v1 (row 204)', () => {
	it('runs every five minutes at :02, one at a time, the next tick its retry', () => {
		const fn = drovrOutboxReplay as unknown as {
			config: Record<string, unknown>
			trigger: unknown
		}
		expect(fn.config).toMatchObject({
			id: 'drovr-outbox-replay-v1',
			retries: 0,
			concurrency: [{ limit: 1 }],
		})
		expect(fn.trigger).toEqual([
			{ cron: '2-57/5 * * * *' },
			{ event: 'drovr/outbox.replay-requested' },
		])
	})
})
