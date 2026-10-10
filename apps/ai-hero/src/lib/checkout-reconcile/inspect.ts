import { merchantCharge, merchantSession, purchases, users } from '@/db/schema'
import { and, eq, gte, inArray } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'

/** Read-only database surface. Both the app `db` and a script pool fit. */
export type CheckoutReadDatabase = Pick<
	MySqlDatabase<any, any, any>,
	'select'
>

/** What the database holds for one checkout session and its Stripe charge. */
export type CheckoutFulfillmentState = {
	chargeIds: string[]
	merchantSessionIds: string[]
	purchaseIds: string[]
}

/**
 * Finds every purchase linked to the session, by merchant charge or by
 * merchant session. Any purchase counts, whatever its status, so a refunded
 * or transferred purchase is never fulfilled a second time.
 *
 * The charge arm runs alone first: `MerchantCharge.identifier` and
 * `Purchase.merchantChargeId` are indexed, and the adapter writes charge,
 * session and purchase in one transaction, so it answers every fulfilled
 * session. The session arm (`MerchantSession.identifier` and
 * `Purchase.merchantSessionId` are not indexed, so it scans) runs only when
 * the charge arm finds nothing, which means a stranded session. The arms are
 * separate queries because MySQL drops both indexes for an OR across them.
 */
export async function inspectCheckoutFulfillment(
	db: CheckoutReadDatabase,
	input: { checkoutSessionId: string; chargeId: string | null },
): Promise<CheckoutFulfillmentState> {
	const chargeRows = input.chargeId
		? await db
				.select({ id: merchantCharge.id })
				.from(merchantCharge)
				.where(eq(merchantCharge.identifier, input.chargeId))
		: []
	const chargePurchaseRows = chargeRows.length
		? await db
				.select({ id: purchases.id })
				.from(purchases)
				.where(
					inArray(
						purchases.merchantChargeId,
						chargeRows.map((row) => row.id),
					),
				)
		: []
	if (chargePurchaseRows.length > 0) {
		return {
			chargeIds: chargeRows.map((row) => row.id),
			merchantSessionIds: [],
			purchaseIds: [...new Set(chargePurchaseRows.map((row) => row.id))],
		}
	}

	const sessionRows = await db
		.select({ id: merchantSession.id })
		.from(merchantSession)
		.where(eq(merchantSession.identifier, input.checkoutSessionId))
	const sessionPurchaseRows = sessionRows.length
		? await db
				.select({ id: purchases.id })
				.from(purchases)
				.where(
					inArray(
						purchases.merchantSessionId,
						sessionRows.map((row) => row.id),
					),
				)
		: []
	return {
		chargeIds: chargeRows.map((row) => row.id),
		merchantSessionIds: sessionRows.map((row) => row.id),
		purchaseIds: [...new Set(sessionPurchaseRows.map((row) => row.id))],
	}
}

/** Purchase statuses that mean the buyer has the product right now. */
const ACTIVE_PURCHASE_STATUSES = ['Valid', 'Restricted']

/**
 * Finds active purchases of one product that one buyer got at or after
 * `since`, through any path: a gift, a coupon redemption, a transfer, or a
 * hand fix after a reconciler alert. Those are invisible to the charge and
 * session lookups, so without this the reconciler would sell the buyer the
 * product a second time. Uses `idx_Purchase_on_userId_status_productId` and
 * the unique `User.email`.
 */
export async function findBuyerProductPurchaseIds(
	db: CheckoutReadDatabase,
	input: {
		userId: string | null
		email: string | null
		productId: string
		since: Date
	},
): Promise<string[]> {
	let userId = input.userId
	if (!userId && input.email) {
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, input.email.trim().toLowerCase()))
			.limit(1)
		userId = user?.id ?? null
	}
	if (!userId) return []
	const rows = await db
		.select({ id: purchases.id })
		.from(purchases)
		.where(
			and(
				eq(purchases.userId, userId),
				inArray(purchases.status, ACTIVE_PURCHASE_STATUSES),
				eq(purchases.productId, input.productId),
				gte(purchases.createdAt, input.since),
			),
		)
	return rows.map((row) => row.id)
}

const LOOKUP_BATCH = 100

/**
 * Returns the checkout session ids that already have a purchase.
 *
 * The adapter writes the merchant charge, merchant session and purchase in
 * one transaction. The charge lookup uses indexed columns
 * (`MerchantCharge.identifier`, `Purchase.merchantChargeId`), so it answers
 * every session the list call expanded a charge for. Only sessions with no
 * charge id fall through to the merchant session lookup, which scans, so it
 * normally runs for none. A charge with no purchase is stranded, whatever
 * the session lookup would say, and the fulfill function re-checks both.
 */
export async function findFulfilledCheckoutSessionIds(
	db: CheckoutReadDatabase,
	sessions: readonly { checkoutSessionId: string; chargeId: string | null }[],
): Promise<Set<string>> {
	const fulfilled = new Set<string>()
	const sessionByCharge = new Map(
		sessions
			.filter((session) => session.chargeId)
			.map((session) => [session.chargeId as string, session.checkoutSessionId]),
	)
	const chargeIds = [...sessionByCharge.keys()]
	for (let index = 0; index < chargeIds.length; index += LOOKUP_BATCH) {
		const rows = await db
			.select({ identifier: merchantCharge.identifier })
			.from(merchantCharge)
			.innerJoin(purchases, eq(purchases.merchantChargeId, merchantCharge.id))
			.where(
				inArray(merchantCharge.identifier, chargeIds.slice(index, index + LOOKUP_BATCH)),
			)
		for (const row of rows) {
			const checkoutSessionId = sessionByCharge.get(row.identifier)
			if (checkoutSessionId) fulfilled.add(checkoutSessionId)
		}
	}

	const remaining = sessions
		.filter((session) => !session.chargeId)
		.map((session) => session.checkoutSessionId)
	for (let index = 0; index < remaining.length; index += LOOKUP_BATCH) {
		const rows = await db
			.select({ identifier: merchantSession.identifier })
			.from(merchantSession)
			.innerJoin(purchases, eq(purchases.merchantSessionId, merchantSession.id))
			.where(
				inArray(merchantSession.identifier, remaining.slice(index, index + LOOKUP_BATCH)),
			)
		for (const row of rows) fulfilled.add(row.identifier)
	}
	return fulfilled
}
