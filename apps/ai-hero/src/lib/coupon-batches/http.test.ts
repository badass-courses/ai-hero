import { beforeEach, expect, it, vi } from 'vitest'
import { BatchProblem, MAX_MANIFEST_BYTES } from './contract'

const mocks = vi.hoisted(() => ({
	error: vi.fn(),
	authorize: vi.fn(),
	admit: vi.fn(),
	send: vi.fn(),
	after: vi.fn<[callback: () => Promise<void>], void>(),
}))
vi.mock('@/server/logger', () => ({ log: { error: mocks.error } }))
vi.mock('next/server', () => ({ after: mocks.after }))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: mocks.send } }))
vi.mock('./runtime', () => ({
	COUPON_BATCH_WAKE: 'fixture/wake',
	couponBatchRuntime: () => ({
		authorize: mocks.authorize,
		admit: mocks.admit,
	}),
}))

import { handlers } from '@/app/api/commerce/coupon-batches/handlers'

const url = 'https://example.test/api/commerce/coupon-batches'
const secret = 'c5comp_never_log_this'
const manifest = {
	campaignRef: 'test',
	templateId: 'c5-comp-v1',
	template: {
		productId: 'product-s00zs',
		percentageDiscount: 1,
		maxUses: 1,
		deadlineAt: '2030-01-01T00:00:00Z',
	},
	items: [{ intentKey: 'test-intent' }],
}
const request = (extra: Record<string, string> = {}) =>
	new Request(url, {
		method: 'POST',
		body: JSON.stringify(manifest),
		headers: {
			authorization: `Bearer ${secret}`,
			'idempotency-key': 'test-batch',
			...extra,
		},
	})

beforeEach(() => {
	vi.resetAllMocks()
})

it('logs only the static route and allowlisted error class for unknown 503s', async () => {
	mocks.authorize.mockRejectedValueOnce(
		Object.assign(new TypeError(secret), { cause: secret }),
	)
	const result = await handlers.preview(request())
	expect(result.status).toBe(503)
	expect(await result.text()).not.toContain(secret)
	expect(mocks.error.mock.calls).toEqual([
		[
			'coupon_batch.unexpected_failure',
			{
				route: 'POST /api/commerce/coupon-batches/preview',
				phase: 'request',
				errorClass: 'TypeError',
			},
		],
	])
})

it('does not log routine refusals and returns 413 before admission', async () => {
	mocks.authorize.mockRejectedValueOnce(
		new BatchProblem(403, 'coupon_batch_forbidden'),
	)
	expect((await handlers.submit(request())).status).toBe(403)
	const big = await handlers.submit(
		request({ 'content-length': String(MAX_MANIFEST_BYTES + 1) }),
	)
	expect(big.status).toBe(413)
	expect(await big.json()).toMatchObject({ title: 'manifest_too_large' })
	expect(mocks.admit).not.toHaveBeenCalled()
	expect(mocks.error).not.toHaveBeenCalled()
})

it('logs a failed after wake without changing durable 202 or trusting an error name', async () => {
	mocks.admit.mockResolvedValueOnce({
		batchId: 'fixture',
		initialStatus: { counts: { queued: 1 } },
	})
	mocks.send.mockRejectedValueOnce(
		Object.assign(new Error(secret), { name: secret }),
	)
	expect((await handlers.submit(request())).status).toBe(202)
	await mocks.after.mock.calls[0]![0]()
	expect(mocks.error.mock.calls).toEqual([
		[
			'coupon_batch.unexpected_failure',
			{
				route: 'POST /api/commerce/coupon-batches',
				phase: 'wake',
				errorClass: 'UnknownError',
			},
		],
	])
})
