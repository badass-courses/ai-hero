import { cache, type ReactNode } from 'react'
import { isC5OnSale } from '@/lib/c5-pricing/c5-on-sale'
import { c5PricingClosed } from '@/lib/c5-pricing/switch-server'

import { C5SaleClientSwitch } from './c5-sale-client-switch'

// Request-scoped only: never cache an operator's kill switch across requests.
const pricingClosed = cache(c5PricingClosed)

/** Preserve the original surface verbatim outside the sale or with C5 disabled. */
export async function C5SaleSwitch({
	children,
	fallback = null,
}: {
	children: ReactNode
	fallback?: ReactNode
}) {
	const withinWindow = isC5OnSale()
	const closed = withinWindow ? await pricingClosed() : true
	return (
		<C5SaleClientSwitch
			pricingClosed={closed}
			initialFeaturedActive={withinWindow}
			fallback={fallback}
		>
			{children}
		</C5SaleClientSwitch>
	)
}
