import { describe, expect, it } from 'vitest'
import { isStripeChargeId } from './stripe-charge-id'

describe('isStripeChargeId', () => {
	it.each(['ch_test', 'py_test'])('accepts %s', (id) => {
		expect(isStripeChargeId(id)).toBe(true)
	})
	it.each([
		'pi_test',
		'cs_test',
		'merchant-test',
		'other_test',
		'',
		null,
		undefined,
	])('rejects %s', (id) => {
		expect(isStripeChargeId(id)).toBe(false)
	})
})
