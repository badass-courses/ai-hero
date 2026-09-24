import { describe, expect, it } from 'vitest'

import { syntheticCheckoutRefusal } from './synthetic-checkout'

describe('synthetic principal checkout', () => {
	it('refuses a checkout by a synthetic principal with problem+json 403', async () => {
		const refusal = syntheticCheckoutRefusal(
			'/api/coursebuilder/checkout/stripe',
			'synthetic_0123456789abcdef01234567',
		)
		expect(refusal?.status).toBe(403)
		expect(refusal?.headers.get('content-type')).toBe('application/problem+json')
		expect(await refusal?.json()).toMatchObject({
			type: 'urn:aihero:problem:synthetic-checkout-refused',
		})
	})

	it('lets real buyers, signed-out buyers and synthetic price reads through', () => {
		expect(syntheticCheckoutRefusal('/api/coursebuilder/checkout/stripe', 'user-1')).toBeUndefined()
		expect(syntheticCheckoutRefusal('/api/coursebuilder/checkout/stripe', undefined)).toBeUndefined()
		expect(
			syntheticCheckoutRefusal(
				'/api/coursebuilder/prices-formatted',
				'synthetic_0123456789abcdef01234567',
			),
		).toBeUndefined()
	})
})
