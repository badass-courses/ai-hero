import 'server-only'
import type { PricingPolicyData } from '@ai-hero/front-desk-support/pricing'
import { db } from '@/db'
import { products } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { policyOpeningWindow } from './buyer-opening'
import { C5_PRODUCT_ID } from './products'

/** Fresh product close as well as policy close: gifts cannot extend either. */
export async function c5OpeningWindow(policy: PricingPolicyData | null) {
	const window = policyOpeningWindow(policy)
	if (!window) return null
	try {
		const [product] = await db
			.select({ fields: products.fields })
			.from(products)
			.where(eq(products.id, C5_PRODUCT_ID))
			.limit(1)
		if (!product) return null
		const close = product.fields?.closeEnrollment
		const open = product.fields?.openEnrollment
		return {
			...window,
			opensAt:
				typeof open === 'string'
					? Math.max(window.opensAt ?? -Infinity, Date.parse(open))
					: window.opensAt,
			closesAt: Math.min(
				window.closesAt,
				typeof close === 'string' ? Date.parse(close) : Infinity,
			),
		}
	} catch {
		return null
	}
}
