import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/purchase-disputes', () => ({
	isUserBlockedFromPurchasing: vi.fn(async () => {
		throw new Error('tests inject the block lookup')
	}),
}))

import { purchaseBlockedCheckoutRefusal } from './purchase-block-checkout'

const url =
	'https://www.example.test/api/coursebuilder/checkout/stripe?productId=p'

describe('purchase-blocked checkout refusal', () => {
	it('redirects a blocked buyer to the support message before Stripe', async () => {
		const isBlocked = vi.fn(async () => true)
		const response = await purchaseBlockedCheckoutRefusal(
			url,
			'/api/coursebuilder/checkout/stripe',
			'user-blocked',
			isBlocked,
		)

		expect(isBlocked).toHaveBeenCalledWith('user-blocked')
		expect(response?.status).toBe(303)
		expect(response?.headers.get('location')).toBe(
			'https://www.example.test/subscribe/error?reason=purchase-blocked',
		)
	})

	it('lets an unblocked buyer through', async () => {
		await expect(
			purchaseBlockedCheckoutRefusal(
				url,
				'/api/coursebuilder/checkout/stripe',
				'user-ok',
				async () => false,
			),
		).resolves.toBeUndefined()
	})

	it.each([
		['/api/coursebuilder/prices-formatted', 'user-blocked'],
		['/api/coursebuilder/checkout/stripe', undefined],
	])('does not look up %s for user %s', async (pathname, userId) => {
		const isBlocked = vi.fn(async () => true)
		await expect(
			purchaseBlockedCheckoutRefusal(url, pathname, userId, isBlocked),
		).resolves.toBeUndefined()
		expect(isBlocked).not.toHaveBeenCalled()
	})
})
