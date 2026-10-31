import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn((_config, _trigger, handler) => ({ handler })),
	list: vi.fn(),
	write: vi.fn(),
	getPurchase: vi.fn(),
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {},
}))
vi.mock('@/lib/subscriber-marketing/purchase-refund-contact-events', () => ({
	writePurchaseRefundContactEvents: mocks.write,
}))
vi.mock('stripe', () => ({
	default: class {
		refunds = { list: mocks.list }
	},
}))

import { capturePurchaseRefundContactEvent } from './capture-purchase-refund-contact-event'
const registered = capturePurchaseRefundContactEvent as unknown as {
	handler: (input: Record<string, unknown>) => Promise<unknown>
}
const run = (data: Record<string, unknown>) =>
	registered.handler({
		event: { data },
		step: { run: (_name: string, work: () => unknown) => work() },
		db: { getPurchaseForStripeCharge: mocks.getPurchase },
	})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getPurchase.mockResolvedValue({ id: 'purch_1' })
	mocks.write.mockResolvedValue({ written: 2, duplicates: 0 })
})

describe('refund capture observer', () => {
	it('consumes SDK auto-pagination and retains individual refund facts without provider mutation', async () => {
		const refunds = Array.from({ length: 101 }, (_, index) => ({
			id: `re_${index}`,
			status: 'succeeded',
			amount: 100,
			currency: 'usd',
			created: 1790812800,
			metadata: { private: 'not persisted' },
		}))
		mocks.list.mockReturnValue(
			(async function* () {
				for (const refund of refunds) yield refund
			})(),
		)
		expect(await run({ stripeChargeId: 'ch_1' })).toEqual({
			written: 2,
			duplicates: 0,
		})
		expect(mocks.list).toHaveBeenCalledWith({ charge: 'ch_1', limit: 100 })
		const written = mocks.write.mock.calls[0]?.[0]
		expect(written.purchaseId).toBe('purch_1')
		expect(written.refunds).toHaveLength(101)
		expect(written.refunds[100]).toEqual({
			id: 're_100',
			status: 'succeeded',
			amount: 100,
			currency: 'usd',
			created: 1790812800,
		})
	})
	it('retries provider errors and missing purchase; never fabricates a zero refund', async () => {
		mocks.getPurchase.mockResolvedValue(null)
		await expect(run({ merchantChargeId: 'ch_legacy' })).rejects.toThrow(
			'Refund purchase not available',
		)
		mocks.getPurchase.mockResolvedValue({ id: 'purch_1' })
		mocks.list.mockImplementation(() => {
			throw new Error('provider unavailable')
		})
		await expect(run({ stripeChargeId: 'ch_1' })).rejects.toThrow(
			'provider unavailable',
		)
		expect(mocks.write).not.toHaveBeenCalled()
	})
	it('skips only missing charge IDs', async () => {
		expect(await run({})).toEqual({
			status: 'skipped',
			reason: 'charge-missing',
		})
		expect(mocks.list).not.toHaveBeenCalled()
	})
})
