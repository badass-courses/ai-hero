import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	record: vi.fn(),
	error: vi.fn(),
}))
vi.mock('@/db/client', () => ({ db: {} }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.create },
}))
vi.mock('@/lib/paid-coupon-usage', () => ({
	recordPaidCouponUse: mocks.record,
}))
vi.mock('@/server/logger', () => ({ log: { error: mocks.error } }))

import './count-paid-coupon-use'

const [config, trigger, handler] = mocks.create.mock.calls[0]!
const event = { data: { purchaseId: 'purchase-fixture' } }
const step = {
	run: async (_id: string, fn: () => Promise<unknown>) => fn(),
	sleep: vi.fn(),
}

beforeEach(() => {
	mocks.record.mockReset()
	mocks.error.mockClear()
	step.sleep.mockClear()
})

describe('count paid coupon use', () => {
	it('listens for every new purchase and keys runs by purchase id', async () => {
		expect(config).toMatchObject({
			id: 'count-paid-coupon-use',
			idempotency: 'event.data.purchaseId',
		})
		expect(trigger).toEqual({ event: 'commerce/new-purchase-created' })
		mocks.record.mockResolvedValue('counted')
		await expect(handler({ event, step })).resolves.toBe('counted')
		expect(mocks.record).toHaveBeenCalledWith(
			expect.anything(),
			'purchase-fixture',
		)
		expect(step.sleep).not.toHaveBeenCalled()
	})

	it('finishes a free redemption without waiting or logging a failure', async () => {
		mocks.record.mockResolvedValue('not_applicable')
		await expect(handler({ event, step })).resolves.toBe('not_applicable')
		expect(mocks.record).toHaveBeenCalledOnce()
		expect(step.sleep).not.toHaveBeenCalled()
		expect(mocks.error).not.toHaveBeenCalled()
	})

	it('re-reads pending purchase rows instead of dropping the event', async () => {
		mocks.record
			.mockResolvedValueOnce('pending')
			.mockResolvedValueOnce('pending')
			.mockResolvedValueOnce('counted')
		await expect(handler({ event, step })).resolves.toBe('counted')
		expect(step.sleep.mock.calls.map((args) => args[1])).toEqual(['1m', '15m'])
		expect(mocks.error).not.toHaveBeenCalled()
	})

	it('logs an actionable purchase id on exhausted pending checks and terminal failure', async () => {
		mocks.record.mockResolvedValue('pending')
		await expect(handler({ event, step })).resolves.toBe('pending')
		expect(mocks.error).toHaveBeenCalledWith('coupon_usage.accounting_failed', {
			purchaseId: 'purchase-fixture',
			reason: 'purchase-not-ready',
		})
		await config.onFailure({ event: { data: { event } } })
		expect(mocks.error).toHaveBeenCalledWith('coupon_usage.accounting_failed', {
			purchaseId: 'purchase-fixture',
		})
	})
})
