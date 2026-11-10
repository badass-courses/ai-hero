import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn((_config, _trigger, handler) => handler),
	createAttribution: vi.fn(),
	sendGA4Event: vi.fn(),
	extractGA4ClientId: vi.fn(),
	resolveClientId: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn() },
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/lib/shortlinks-query', () => ({
	createShortlinkAttribution: mocks.createAttribution,
}))
vi.mock('@/lib/ga4-measurement', () => ({
	sendGA4Event: mocks.sendGA4Event,
	extractGA4ClientId: mocks.extractGA4ClientId,
}))
vi.mock('@/lib/ga4-purchase-fields', () => ({
	resolvePurchaseGA4ClientId: mocks.resolveClientId,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { shortlinkAttribution } from './shortlink-attribution'

const event = {
	data: {
		purchaseId: 'purchase-1',
		checkoutSessionId: 'checkout-1',
		productType: 'self-paced',
	},
}
const purchase = {
	id: 'purchase-1',
	productId: 'product-1',
	userId: 'user-1',
	totalAmount: '199.00',
	fields: { gaClientId: 'stored-client' },
}
const product = { id: 'product-1', name: 'Test Course' }
const user = { id: 'user-1', email: 'buyer@example.com' }
const receipt = {
	status: 'sent',
	eventNames: ['purchase'],
	eventCount: 1,
	httpStatus: 204,
}
const db = { getPurchase: vi.fn(), getProduct: vi.fn(), getUserById: vi.fn() }
const getCheckoutSession = vi.fn()
const paymentProvider = {
	options: { paymentsAdapter: { getCheckoutSession } },
}
type Step = {
	run: (id: string, callback: () => Promise<unknown>) => Promise<unknown>
}
const handler = shortlinkAttribution as unknown as (args: {
	event: typeof event
	step: Step
	db: typeof db
	paymentProvider?: typeof paymentProvider
}) => Promise<unknown>
const createStep = () => ({
	run: vi.fn(async (_id: string, callback: () => Promise<unknown>) =>
		callback(),
	),
})

beforeEach(() => {
	vi.resetAllMocks()
	db.getPurchase.mockResolvedValue(purchase)
	db.getProduct.mockResolvedValue(product)
	db.getUserById.mockResolvedValue(user)
	getCheckoutSession.mockResolvedValue({
		metadata: { shortlinkRef: 'test-link' },
	})
	mocks.resolveClientId.mockReturnValue('stored-client')
	mocks.extractGA4ClientId.mockReturnValue('123.456')
	mocks.sendGA4Event.mockResolvedValue(receipt)
})

describe('shortlink attribution', () => {
	it('keeps attribution and GA4 payloads and checkpoints separate from merged reads', async () => {
		const step = createStep()
		await expect(
			handler({ event, step, db, paymentProvider }),
		).resolves.toEqual({
			recorded: true,
			shortlinkRef: 'test-link',
			userId: user.id,
			ga4: receipt,
		})
		expect(step.run.mock.calls.map(([id]) => id)).toEqual([
			'get attribution context',
			'record attribution',
			'emit-ga4-purchase',
		])
		expect(db.getPurchase).toHaveBeenCalledWith('purchase-1')
		expect(db.getProduct).toHaveBeenCalledWith('product-1')
		expect(db.getUserById).toHaveBeenCalledWith('user-1')
		expect(getCheckoutSession).toHaveBeenCalledWith('checkout-1')
		expect(mocks.createAttribution).toHaveBeenCalledWith({
			shortlinkSlug: 'test-link',
			email: user.email,
			userId: user.id,
			type: 'purchase',
			metadata: {
				productId: product.id,
				productName: product.name,
				purchaseId: purchase.id,
				totalAmount: purchase.totalAmount,
				productType: 'self-paced',
			},
		})
		expect(mocks.resolveClientId).toHaveBeenCalledOnce()
		expect(mocks.resolveClientId).toHaveBeenCalledWith(purchase.fields)
		expect(mocks.extractGA4ClientId).toHaveBeenCalledOnce()
		expect(mocks.extractGA4ClientId).toHaveBeenCalledWith('stored-client')
		expect(mocks.sendGA4Event).toHaveBeenCalledWith({
			client_id: '123.456',
			user_id: user.id,
			events: [
				{
					name: 'purchase',
					params: {
						transaction_id: purchase.id,
						value: 199,
						currency: 'USD',
						items: [
							{
								item_id: product.id,
								item_name: product.name,
								price: 199,
								quantity: 1,
							},
						],
					},
				},
			],
		})
		const calls = [
			db.getPurchase,
			db.getProduct,
			db.getUserById,
			getCheckoutSession,
			mocks.createAttribution,
			mocks.sendGA4Event,
		]
		for (const call of calls) expect(call).toHaveBeenCalledOnce()
		const order = calls.map((mock) => mock.mock.invocationCallOrder[0])
		expect(order).toEqual([...order].sort((a, b) => a! - b!))
	})

	it('retries merged reads and a failed GA4 step without duplicating attribution', async () => {
		const completed = new Map<string, unknown>()
		const step = {
			run: vi.fn(async (id: string, callback: () => Promise<unknown>) => {
				if (completed.has(id)) return completed.get(id)
				// Lost completion for the read-only step is safe to replay.
				if (id === 'get attribution context') await callback()
				const result = await callback()
				completed.set(id, JSON.parse(JSON.stringify(result)))
				return result
			}),
		}
		mocks.sendGA4Event
			.mockRejectedValueOnce(new Error('GA4 unavailable'))
			.mockResolvedValue(receipt)
		await expect(handler({ event, step, db, paymentProvider })).rejects.toThrow(
			'GA4 unavailable',
		)
		await expect(
			handler({ event, step, db, paymentProvider }),
		).resolves.toMatchObject({ recorded: true, ga4: receipt })
		expect(db.getPurchase).toHaveBeenCalledTimes(2)
		expect(db.getProduct).toHaveBeenCalledTimes(2)
		expect(db.getUserById).toHaveBeenCalledTimes(2)
		expect(mocks.createAttribution).toHaveBeenCalledTimes(1)
		expect(getCheckoutSession).toHaveBeenCalledTimes(1)
		expect(mocks.sendGA4Event).toHaveBeenCalledTimes(2)
	})

	it('skips before reading without checkout or provider', async () => {
		const step = createStep()
		await expect(handler({ event, step, db })).resolves.toEqual({
			skipped: true,
			reason: 'No checkout session or payment provider',
		})
		expect(step.run).not.toHaveBeenCalled()
	})

	it.each(['purchase', 'user'])(
		'skips a missing %s without writing',
		async (missing) => {
			if (missing === 'purchase') db.getPurchase.mockResolvedValue(null)
			else db.getUserById.mockResolvedValue(null)
			const step = createStep()
			await expect(
				handler({ event, step, db, paymentProvider }),
			).resolves.toEqual({
				skipped: true,
				reason:
					missing === 'purchase' ? 'Purchase not found' : 'User not found',
			})
			expect(step.run).toHaveBeenCalledTimes(1)
			expect(mocks.createAttribution).not.toHaveBeenCalled()
			expect(mocks.sendGA4Event).not.toHaveBeenCalled()
		},
	)

	it('still emits GA4 when no shortlink metadata exists', async () => {
		getCheckoutSession.mockResolvedValue({ metadata: {} })
		await expect(
			handler({ event, step: createStep(), db, paymentProvider }),
		).resolves.toEqual({
			skipped: true,
			reason: 'No shortlink reference in metadata',
			ga4: receipt,
		})
		expect(mocks.createAttribution).not.toHaveBeenCalled()
		expect(mocks.sendGA4Event).toHaveBeenCalledOnce()
	})

	it('still emits GA4 after an attribution error', async () => {
		mocks.createAttribution.mockRejectedValue(
			new Error('attribution unavailable'),
		)
		await expect(
			handler({ event, step: createStep(), db, paymentProvider }),
		).resolves.toEqual({ error: 'attribution unavailable', ga4: receipt })
		expect(mocks.sendGA4Event).toHaveBeenCalledOnce()
	})
})
