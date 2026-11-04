import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn((config, trigger, handler) => ({ config, trigger, handler })),
	runPage: vi.fn(async () => ({ status: 'disabled' })),
}))

vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {},
}))
vi.mock('@/lib/subscriber-marketing/purchase-exit-proof.server', () => ({
	findCrashCoursePurchaseStatuses: vi.fn(),
	purchaseExitProofEnabled: vi.fn(),
}))
vi.mock('@/lib/subscriber-marketing/purchase-handoff-exit', () => ({
	runPurchaseHandoffExitPage: mocks.runPage,
}))
vi.mock('@/server/logger', () => ({ log: { info: vi.fn() } }))

import { newsletterPurchaseExitProof } from './newsletter-purchase-exit-proof'

describe('purchase exit proof schedules', () => {
	it('registers the proof producer hourly without changing its execution limits', () => {
		expect(newsletterPurchaseExitProof).toBeDefined()
		expect(mocks.createFunction.mock.calls[0]?.slice(0, 2)).toEqual([
			{
				id: 'newsletter-purchase-exit-proof-v1',
				name: 'Newsletter: accept purchase handoff as exit proof',
				retries: 1,
				concurrency: 1,
			},
			{ cron: '0 * * * *' },
		])
	})

	it('keeps the disabled pass a no-op', async () => {
		const handler = mocks.createFunction.mock.calls[0]![2]
		const run = vi.fn(async (_id: string, work: () => unknown) => work())
		await expect(handler({ step: { run } })).resolves.toEqual({ outcomes: {} })
		expect(mocks.runPage).toHaveBeenCalledTimes(1)
		expect(run).toHaveBeenCalledTimes(1)
	})

	it('keeps the fallback Inngest registration refresh daily', () => {
		const config = JSON.parse(readFileSync('vercel.json', 'utf8'))
		expect(config.crons).toEqual([{ path: '/api/cron', schedule: '0 5 * * *' }])
	})
})
