import { describe, expect, it } from 'vitest'

import { courseBuilderCoreFunctions } from '@coursebuilder/server'

import {
	CHECKOUT_OWNER_IDENTITY_GUARD_MARKER,
	decideCheckoutOwner,
	isCheckoutSessionOwner,
	type CheckoutOwnerUser,
} from './checkout-owner-resolution'

const signedInUser: CheckoutOwnerUser = {
	id: 'user_signed_in',
	email: 'account@example.com',
}

describe('decideCheckoutOwner', () => {
	it('keeps the signed-in user canonical when the billing email matches', () => {
		expect(
			decideCheckoutOwner({
				metadataUserId: signedInUser.id,
				metadataUser: signedInUser,
				billingEmail: 'account@example.com',
			}),
		).toEqual({ source: 'metadata-user', user: signedInUser, isNewUser: false })
	})

	it('keeps the signed-in user canonical when the billing email differs', () => {
		expect(
			decideCheckoutOwner({
				metadataUserId: signedInUser.id,
				metadataUser: signedInUser,
				billingEmail: 'billing@corporate-card.example.com',
			}),
		).toEqual({ source: 'metadata-user', user: signedInUser, isNewUser: false })
	})

	it('resolves an anonymous checkout by billing email (existing account or new user)', () => {
		expect(
			decideCheckoutOwner({
				metadataUserId: null,
				metadataUser: null,
				billingEmail: 'buyer@example.com',
			}),
		).toEqual({ source: 'billing-email', email: 'buyer@example.com' })
	})

	it('falls back to the billing email when the metadata user no longer exists', () => {
		expect(
			decideCheckoutOwner({
				metadataUserId: 'user_deleted',
				metadataUser: null,
				billingEmail: 'buyer@example.com',
			}),
		).toEqual({ source: 'billing-email', email: 'buyer@example.com' })
	})

	it('rejects a loaded user that does not match metadata.userId', () => {
		expect(() =>
			decideCheckoutOwner({
				metadataUserId: 'user_other',
				metadataUser: signedInUser,
				billingEmail: 'buyer@example.com',
			}),
		).toThrow(CHECKOUT_OWNER_IDENTITY_GUARD_MARKER)
	})

	it('rejects a checkout with no owner identity at all', () => {
		expect(() =>
			decideCheckoutOwner({
				metadataUserId: null,
				metadataUser: null,
				billingEmail: null,
			}),
		).toThrow(CHECKOUT_OWNER_IDENTITY_GUARD_MARKER)
	})

	it('is deterministic across retries', () => {
		const first = decideCheckoutOwner({
			metadataUserId: signedInUser.id,
			metadataUser: signedInUser,
			billingEmail: 'billing@corporate-card.example.com',
		})
		const second = decideCheckoutOwner({
			metadataUserId: signedInUser.id,
			metadataUser: signedInUser,
			billingEmail: 'billing@corporate-card.example.com',
		})
		expect(second).toEqual(first)
	})
})

describe('isCheckoutSessionOwner', () => {
	it('routes by owner id even when the billing email differs', () => {
		expect(
			isCheckoutSessionOwner({
				purchaseUserId: signedInUser.id,
				purchaseEmail: 'billing@corporate-card.example.com',
				sessionUserId: signedInUser.id,
				sessionUserEmail: signedInUser.email,
			}),
		).toBe(true)
	})

	it('routes by email match for buyers without an id match', () => {
		expect(
			isCheckoutSessionOwner({
				purchaseUserId: 'user_temp',
				purchaseEmail: 'Buyer@Example.com',
				sessionUserId: null,
				sessionUserEmail: 'buyer@example.com',
			}),
		).toBe(true)
	})

	it('does not route a signed-in non-owner', () => {
		expect(
			isCheckoutSessionOwner({
				purchaseUserId: 'user_owner',
				purchaseEmail: 'owner@example.com',
				sessionUserId: 'user_other',
				sessionUserEmail: 'other@example.com',
			}),
		).toBe(false)
	})

	it('does not route a signed-out viewer', () => {
		expect(
			isCheckoutSessionOwner({
				purchaseUserId: 'user_owner',
				purchaseEmail: 'owner@example.com',
				sessionUserId: null,
				sessionUserEmail: null,
			}),
		).toBe(false)
	})
})

describe('checkout completion function', () => {
	it('keeps checkout completion idempotent per checkout session', () => {
		const checkoutCompleted = courseBuilderCoreFunctions.find(
			(fn) => fn.config.id === 'stripe-checkout-session-completed',
		)
		const config = checkoutCompleted?.config as
			| { id: string; idempotency?: string }
			| undefined
		expect(config?.idempotency).toBe('event.data.stripeEvent.data.object.id')
	})
})
