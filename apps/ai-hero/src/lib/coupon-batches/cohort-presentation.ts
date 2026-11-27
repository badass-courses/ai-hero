import type { CouponPort } from '@coursebuilder/core/ports'
import type { db } from '@/db/client'
import { inSelectorNamespace, PRODUCT } from './namespace'

/** Leave ordinary cohort requests on the original adapter, without loading claims. */
export async function cohortCouponPresentation<
	T extends Pick<CouponPort, 'getCoupon'>,
>(
	adapter: T,
	database: typeof db,
	productId: string,
	code: unknown,
): Promise<T> {
	if (productId !== PRODUCT || !inSelectorNamespace(code)) return adapter
	const { c5CompPresentation } = await import('./free-selector')
	return c5CompPresentation(adapter, database, productId)
}
