import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { C5TeamCheckout, c5TeamCheckoutPath } from './c5-team-checkout'

const cancelUrl = 'http://localhost/for-your-team'

describe('C5 team checkout', () => {
	it.each([2, 4, 5, 9, 10, 29, 30, 100])(
		'posts %i seats to the existing C5 checkout',
		(quantity) => {
			const path = new URL(
				c5TeamCheckoutPath(quantity, cancelUrl),
				'http://localhost',
			)
			expect(path.pathname).toBe('/api/coursebuilder/checkout/stripe')
			expect(Object.fromEntries(path.searchParams)).toEqual({
				productId: 'product-s00zs',
				quantity: String(quantity),
				bulk: 'true',
				cancelUrl,
			})
		},
	)

	it.each([0, 1, 1.5, 101, NaN, Infinity])(
		'refuses invalid team quantity %s',
		(quantity) => {
			expect(() => c5TeamCheckoutPath(quantity, cancelUrl)).toThrow(RangeError)
		},
	)

	it('uses a native POST form with a labelled two-to-100 seat input', () => {
		const html = renderToStaticMarkup(<C5TeamCheckout cancelUrl={cancelUrl} />)
		expect(html).toContain('method="POST"')
		expect(html).toContain('quantity=5')
		expect(html).toContain('min="2"')
		expect(html).toContain('max="100"')
		expect(html).toContain('>Seats</label>')
		expect(html).toContain('>Buy seats</button>')
	})
})
