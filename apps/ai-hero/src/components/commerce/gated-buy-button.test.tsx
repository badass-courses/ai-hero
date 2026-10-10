import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	pricing: {} as Record<string, unknown>,
}))

vi.mock('@coursebuilder/commerce-next/pricing/pricing', () => ({
	usePricing: () => mocks.pricing,
	// The stock button: disabled only on pending, error or sold out.
	BuyButton: ({ children }: { children?: React.ReactNode }) => (
		<button type="submit" data-stock="">
			{children ?? 'Buy Now'}
		</button>
	),
}))

vi.mock('@coursebuilder/ui', () => ({
	Button: ({ children, ...props }: any) => (
		<button {...props}>{children}</button>
	),
}))

import { GatedBuyButton } from './gated-buy-button'

const authoritative = (over: Record<string, unknown>) => ({
	kind: 'priced',
	purchasable: true,
	isUpperBound: false,
	amountCents: 80_000,
	unitAmountCents: 80_000,
	restriction: 'none',
	reasons: [],
	decisionRef: 'c5d1.0000000000000000.-',
	engineVersion: 'synthetic',
	policyVersion: 'synthetic',
	...over,
})

const render = () =>
	renderToStaticMarkup(<GatedBuyButton>Enroll</GatedBuyButton>)

describe('GatedBuyButton', () => {
	beforeEach(() => {
		mocks.pricing = { status: 'success', formattedPrice: {} }
	})

	it('is the stock button for a legacy price', () => {
		expect(render()).toBe('<button type="submit" data-stock="">Enroll</button>')
	})

	it('is the stock button for a chargeable decision', () => {
		mocks.pricing.formattedPrice = { authoritative: authoritative({}) }
		expect(render()).toContain('data-stock=""')
		expect(render()).not.toContain('disabled')
	})

	it.each([
		['bounded', 'Price unavailable'],
		['not-open', 'Not open yet'],
		['closed', 'Enrollment closed'],
		['held', 'Price unavailable'],
	])('disables Buy Now for a %s decision', (kind, label) => {
		mocks.pricing.formattedPrice = {
			authoritative: authoritative({
				kind,
				purchasable: false,
				isUpperBound: kind === 'bounded',
				reasons: ['quotes-unavailable'],
			}),
		}
		const html = render()
		expect(html).not.toContain('type="submit"')
		expect(html).toContain('disabled=""')
		expect(html).toContain(label)
	})

	it('keeps an anonymous buyer a path to sign in, labelled as an upper bound', () => {
		mocks.pricing.formattedPrice = {
			authoritative: authoritative({
				kind: 'bounded',
				purchasable: false,
				isUpperBound: true,
				reasons: ['identity-required'],
			}),
		}
		const html = render()
		expect(html).toContain('type="submit"')
		expect(html).toContain('Sign in to buy')
		expect(html).not.toContain('Enroll')
		expect(html).toContain('Up to this price. Sign in to see yours.')
	})
})
