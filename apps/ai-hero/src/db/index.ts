import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { mysqlTable } from '@/db/mysql-table'
import { guardLegendGiftCouponPaths } from '@/lib/legend-gift-coupon-guard'
import { withSessionAccessBusts } from '@/server/session-access-busts'
import { bustSessionAccessForUser } from '@/server/session-access-runtime'
import { eq } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import type { RequiredPricingAuthority } from '@coursebuilder/commerce/types'
import type { AuthoritativePriceRequest } from '@coursebuilder/core/schemas'

import * as schema from './schema'

import { db } from './client'

export {
	db,
	acquireDatabaseConnection,
	createDatabaseHandle,
	closeDatabasePool,
	type DbTransaction,
	type DbExecutor,
} from './client'

const drizzleAdapter = withSessionAccessBusts(
	guardLegendGiftCouponPaths(DrizzleAdapter<MySqlDatabase<any, any, any>>(
		db,
		mysqlTable,
		stripeProvider,
	)),
	{
		bustUser: bustSessionAccessForUser,
		findMembershipUserId: async (membershipId) =>
			(
				await db.query.organizationMemberships.findFirst({
					where: eq(schema.organizationMemberships.id, membershipId),
					columns: { userId: true },
				})
			)?.userId ?? null,
	},
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
export const courseBuilderAdapter: RequiredPricingAuthority<
	typeof drizzleAdapter
> = Object.assign(drizzleAdapter, {
	authoritativePrice: async (request: AuthoritativePriceRequest) =>
		(await import('@/lib/c5-pricing/server')).c5AuthoritativePrice(request),
})
