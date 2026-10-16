// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	pricing: {} as Record<string, any>,
	setMerchantCoupon: vi.fn(),
}))

vi.mock('@coursebuilder/commerce-next/pricing/pricing', () => ({
	PPPToggle: () => <div data-ppp-toggle />,
}))
vi.mock('@coursebuilder/commerce-next/pricing/pricing-context', () => ({
	usePricing: () => ({
		setMerchantCoupon: mocks.setMerchantCoupon,
		...mocks.pricing,
	}),
}))

import { GatedPPPToggle } from './regional-toggle-gate'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
afterEach(async () => {
	await act(async () => root?.unmount())
	root = null
	vi.clearAllMocks()
})

async function renderGate() {
	const host = document.createElement('div')
	await act(async () => {
		root = createRoot(host)
		root.render(<GatedPPPToggle />)
	})
	return host
}

describe('GatedPPPToggle (home widget)', () => {
	it.each([2, 3, 5])('hides the toggle at quantity %s', async (quantity) => {
		mocks.pricing = { quantity, activeMerchantCoupon: null }
		const host = await renderGate()
		expect(host.querySelector('[data-ppp-toggle]')).toBeNull()
	})

	it('shows the toggle at quantity 1', async () => {
		mocks.pricing = { quantity: 1, activeMerchantCoupon: null }
		const host = await renderGate()
		expect(host.querySelector('[data-ppp-toggle]')).not.toBeNull()
		expect(mocks.setMerchantCoupon).not.toHaveBeenCalled()
	})

	it('clears an applied regional coupon at a team quantity', async () => {
		mocks.pricing = { quantity: 3, activeMerchantCoupon: { type: 'ppp' } }
		await renderGate()
		expect(mocks.setMerchantCoupon).toHaveBeenCalledWith(undefined)
	})

	it('leaves any other merchant coupon alone at a team quantity', async () => {
		mocks.pricing = { quantity: 3, activeMerchantCoupon: { type: 'special' } }
		await renderGate()
		expect(mocks.setMerchantCoupon).not.toHaveBeenCalled()
	})
})
