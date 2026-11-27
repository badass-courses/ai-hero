import { mysqlTable } from '@/db/mysql-table'
import { guardC5CompSelectors } from '@/lib/coupon-batches/adapter-guard'
import { withDefaultCouponInvalidation } from '@/lib/default-coupon-invalidation'
import { guardLegendGiftCouponPaths } from '@/lib/legend-gift-coupon-guard'
import { withPurchaseCountInvalidation } from '@/lib/purchase-count-invalidation'
import { withSessionAccessBusts } from '@/server/session-access-busts'
import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import { eq } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'

import type { db, DbExecutor } from './client'
import { organizationMemberships } from './schema'

export function createAppCommerceAdapter(
	database: typeof db,
	bustUser: (userId: string) => Promise<void>,
	paymentProvider?: Parameters<typeof DrizzleAdapter>[2],
) {
	const base = (executor: DbExecutor) =>
		guardLegendGiftCouponPaths(
			DrizzleAdapter<MySqlDatabase<any, any, any>>(
				executor,
				mysqlTable,
				paymentProvider,
			),
		)
	const sessionWrites = <T extends ReturnType<typeof base>>(
		adapter: T,
		executor: DbExecutor,
		bust: typeof bustUser,
	) =>
		withSessionAccessBusts(adapter, {
			bustUser: bust,
			findMembershipUserId: async (membershipId) =>
				(
					await executor.query.organizationMemberships.findFirst({
						where: eq(organizationMemberships.id, membershipId),
						columns: { userId: true },
					})
				)?.userId ?? null,
		})

	const selectors = guardC5CompSelectors(base(database), async (input) => {
		const { redeemPrivateComp } =
			await import('@/lib/coupon-batches/free-selector')
		const changedUsers = new Set<string>()
		const result = await redeemPrivateComp(database, input, (tx) =>
			// Use the same app guards and membership hooks on the locked connection.
			// The outer purchase wrapper invalidates after commit, not inside it.
			sessionWrites(base(tx), tx, async (id) => {
				changedUsers.add(id)
			}),
		)
		if (result.purchase) {
			if (result.purchase.userId) changedUsers.add(result.purchase.userId)
			// A cache failure must not make a committed single-use claim look failed.
			await Promise.allSettled(
				[...changedUsers].map(async (id) => bustUser(id)),
			)
		}
		return result
	})
	return sessionWrites(
		withDefaultCouponInvalidation(withPurchaseCountInvalidation(selectors)),
		database,
		bustUser,
	)
}
