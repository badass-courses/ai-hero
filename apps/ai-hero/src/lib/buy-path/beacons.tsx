'use client'
import { useEffect } from 'react'
import { createBuyPathLogger, pricingBuyPathId } from './client'

/** Reusable across the current screens and the upcoming post-purchase design. */
export function BuyPathDestinationBeacon({ buyPathId }: { buyPathId: string }) {
	useEffect(() => {
		const emit = createBuyPathLogger(buyPathId)
		emit('client_returned')
		emit('purchase_visible')
		emit('destination_rendered')
	}, [buyPathId])
	return null
}
export function BuyPathPricingBeacon({ productId }: { productId: string }) {
	useEffect(() => {
		const emit = createBuyPathLogger(pricingBuyPathId(), undefined, productId)
		emit('pricing_viewed')
		let checkoutSubmitted = false
		const submit = (event: Event) => {
			const form = event.target
			if (form instanceof HTMLFormElement && form.action.includes('/checkout/'))
				checkoutSubmitted = true
		}
		const leave = () => {
			if (checkoutSubmitted) emit('redirect_to_stripe')
		}
		document.addEventListener('submit', submit, true)
		window.addEventListener('pagehide', leave)
		return () => {
			document.removeEventListener('submit', submit, true)
			window.removeEventListener('pagehide', leave)
		}
	}, [productId])
	return null
}
