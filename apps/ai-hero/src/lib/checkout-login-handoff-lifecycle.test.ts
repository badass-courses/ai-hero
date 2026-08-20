import { describe, expect, it } from 'vitest'

import {
	canTransitionCheckoutLoginHandoff,
	checkoutLoginHandoffSourcesFor,
	checkoutLoginHandoffTransitions,
} from './checkout-login-handoff-lifecycle'

describe('checkout login handoff lifecycle', () => {
	it('has one claim path and one retry path', () => {
		expect(checkoutLoginHandoffTransitions).toEqual({
			issued: ['consuming', 'expired'],
			consuming: ['completed', 'failed_retryable'],
			failed_retryable: ['consuming', 'expired'],
			completed: [],
			expired: [],
		})
		expect(canTransitionCheckoutLoginHandoff('issued', 'consuming')).toBe(
			true,
		)
		expect(
			canTransitionCheckoutLoginHandoff('consuming', 'failed_retryable'),
		).toBe(true)
		expect(
			canTransitionCheckoutLoginHandoff('failed_retryable', 'consuming'),
		).toBe(true)
		expect(checkoutLoginHandoffSourcesFor('consuming')).toEqual([
			'issued',
			'failed_retryable',
		])
		expect(checkoutLoginHandoffSourcesFor('completed')).toEqual([
			'consuming',
		])
	})

	it('does not leave completed or expired', () => {
		expect(canTransitionCheckoutLoginHandoff('completed', 'consuming')).toBe(
			false,
		)
		expect(canTransitionCheckoutLoginHandoff('expired', 'consuming')).toBe(
			false,
		)
	})
})
