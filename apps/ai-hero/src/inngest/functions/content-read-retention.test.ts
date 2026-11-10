import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	deleteBatch: vi.fn(),
	info: vi.fn(),
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: (config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	},
}))
vi.mock('@/lib/content-read-retention', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/content-read-retention')>()),
	deleteExpiredAnonymousContentReadBatch: mocks.deleteBatch,
}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/server/logger', () => ({ log: { info: mocks.info } }))

import { contentReadRetention } from './content-read-retention'

const fn = contentReadRetention as unknown as {
	config: unknown
	trigger: unknown
	handler: (input: {
		step: { run: (id: string, work: () => unknown) => Promise<unknown> }
	}) => Promise<unknown>
}

describe('content read retention cron', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
		mocks.deleteBatch.mockResolvedValue({
			selectedCount: 0,
			deletedCount: 0,
			lastOccurredAt: null,
		})
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('keeps the daily schedule and one step per bounded batch', async () => {
		vi.setSystemTime(new Date('2026-11-10T04:35:00Z'))
		mocks.deleteBatch.mockResolvedValueOnce({
			selectedCount: 1000,
			deletedCount: 1000,
			lastOccurredAt: '2026-10-26T12:00:00Z',
		})
		const run = vi.fn(async (_id: string, work: () => unknown) => work())
		const result = await fn.handler({ step: { run } })

		expect(fn.config).toMatchObject({ concurrency: { limit: 1 } })
		expect(fn.trigger).toEqual({ cron: 'TZ=UTC 35 4 * * *' })
		expect(mocks.deleteBatch.mock.calls.map(([args]) => args)).toEqual([
			{
				cutoff: new Date('2026-10-27T04:35:00Z'),
				after: new Date('2026-10-20T04:35:00Z'),
			},
			{
				cutoff: new Date('2026-10-27T04:35:00Z'),
				after: new Date('2026-10-26T12:00:00Z'),
			},
		])
		expect(run.mock.calls.map(([id]) => id)).toEqual([
			'compute retention cutoff',
			'delete expired batch 0',
			'delete expired batch 1',
		])
		expect(result).toMatchObject({ deletedCount: 1000 })
		expect(mocks.info).toHaveBeenCalledWith(
			'content_read.retention.completed',
			result,
		)
	})

	it.each([
		['2026-11-15T04:35:00Z', '2026-11-01T04:35:00Z', undefined],
		[
			'2026-11-16T04:35:00Z',
			'2026-11-02T04:35:00Z',
			'2026-10-26T04:35:00Z',
		],
	])(
		'reuses the persisted window when a %s run resumes later',
		async (_now, cutoff, after) => {
			// The compute step has already completed; resume on a different weekday.
			vi.setSystemTime(new Date('2026-11-17T04:35:00Z'))
			const run = vi.fn(async (id: string, work: () => unknown) =>
				id === 'compute retention cutoff' ? cutoff : work(),
			)
			await fn.handler({ step: { run } })
			expect(mocks.deleteBatch).toHaveBeenCalledWith({
				cutoff: new Date(cutoff),
				after: after ? new Date(after) : undefined,
			})
		},
	)

	it('stops after the existing 200-batch cap', async () => {
		vi.setSystemTime(new Date('2026-11-10T04:35:00Z'))
		mocks.deleteBatch.mockResolvedValue({
			selectedCount: 1000,
			deletedCount: 1000,
			lastOccurredAt: '2026-10-26T12:00:00Z',
		})
		const run = vi.fn(async (_id: string, work: () => unknown) => work())
		await fn.handler({ step: { run } })
		expect(mocks.deleteBatch).toHaveBeenCalledTimes(200)
		expect(run).toHaveBeenCalledTimes(201)
	})
})
