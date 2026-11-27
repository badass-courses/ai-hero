import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { withPaidCouponUsage } from '@/lib/paid-coupon-usage'
import { bustSessionAccessForUser } from '@/server/session-access-runtime'

import type { RequiredPricingAuthority } from '@coursebuilder/commerce/types'
import type { AuthoritativePriceRequest } from '@coursebuilder/core/schemas'

import { db } from './client'
import { createAppCommerceAdapter } from './commerce-adapter'

export {
	db,
	acquireDatabaseConnection,
	createDatabaseHandle,
	closeDatabasePool,
	type DbTransaction,
	type DbExecutor,
} from './client'

const drizzleAdapter = createAppCommerceAdapter(
	db,
	bustSessionAccessForUser,
	stripeProvider,
)

/**
 * The app's Course Builder adapter. It carries Course Builder's authoritative-price
 * hook, typed `RequiredPricingAuthority`, so a commerce path without the hook
 * does not compile. The hook prices Cohort 005 in-process and returns `null`
 * for every other product, which keeps Course Builder's legacy pricing. It is
 * attached to the adapter object itself, so Course Builder's receivers stay
 * as they were, and loaded on first call to keep `@/db` free of an import
 * cycle.
 */
export const rawCourseBuilderAdapter: RequiredPricingAuthority<
	typeof drizzleAdapter
> = Object.assign(drizzleAdapter, {
	authoritativePrice: async (request: AuthoritativePriceRequest) =>
		(await import('@/lib/c5-pricing/server')).c5AuthoritativePrice(request),
})

// App pricing reads use a separate view. Fulfillment gets the raw ports.
export const courseBuilderAdapter = withPaidCouponUsage(
	rawCourseBuilderAdapter,
	db,
)
