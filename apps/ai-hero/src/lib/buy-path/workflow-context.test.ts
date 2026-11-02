import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buyPathContextForCheckout } from './schema'
import { emitBuyPath } from './server'

const sink = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))
vi.mock('@/server/logger', () => ({ log: sink }))
beforeEach(() => {
	vi.clearAllMocks()
})

const purchase = {
	id: 'purchase_fixture',
	productId: 'product_fixture',
	userId: 'user_fixture',
}
// The three steps the post-purchase readback emits with the workflow context.
const steps = [
	'invariant_checked',
	'invariant_failed',
	'entitlements_granted',
] as const

describe('post-purchase workflow buy-path context', () => {
	it.each(steps)(
		'emits a valid %s event for a Stripe checkout session',
		async (step) => {
			const context = buyPathContextForCheckout('cs_test_fixture', purchase)
			expect(context).not.toBeNull()
			await emitBuyPath(context!, step, {
				outcome: step === 'invariant_failed' ? 'failed' : 'ok',
			})
			expect(sink.error).not.toHaveBeenCalledWith(
				'buy_path.invalid_event',
				expect.anything(),
			)
		},
	)

	it.each(steps)(
		'has no buy path for coupon redemptions, so %s is never emitted invalid',
		async (step) => {
			// core sends checkoutSessionId: `coupon-${purchase.id}` for coupons
			const context = buyPathContextForCheckout(
				`coupon-${purchase.id}`,
				purchase,
			)
			expect(context).toBeNull()
			if (context) await emitBuyPath(context, step)
			expect(sink.error).not.toHaveBeenCalled()
		},
	)

	it('keeps emitting events for a cs_ session through the real readback', () => {
		expect(
			buyPathContextForCheckout('cs_live_a1B2c3', purchase),
		).toMatchObject({ buyPathId: 'cs_live_a1B2c3', purchaseId: purchase.id })
	})

	it('logs the failing path, never the value', async () => {
		await emitBuyPath(
			{
				buyPathId: 'coupon-secret-value',
				purchaseId: 'p',
				productId: null,
				userId: null,
			},
			'invariant_checked',
		)
		expect(sink.error).toHaveBeenCalledWith('buy_path.invalid_event', {
			step: 'invariant_checked',
			field: 'schema',
			issuePaths: ['buyPathId'],
		})
	})
})
