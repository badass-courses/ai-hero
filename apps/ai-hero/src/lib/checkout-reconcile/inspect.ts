import { merchantCharge, merchantSession, purchases } from '@/db/schema'
import { eq, inArray, or } from 'drizzle-orm'
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
 * Finds every purchase linked to the session, by merchant session or by
 * merchant charge. Any purchase counts, whatever its status, so a refunded
 * or transferred purchase is never fulfilled a second time.
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
	const sessionRows = await db
		.select({ id: merchantSession.id })
		.from(merchantSession)
		.where(eq(merchantSession.identifier, input.checkoutSessionId))
	const conditions = [
		...chargeRows.map((row) => eq(purchases.merchantChargeId, row.id)),
		...sessionRows.map((row) => eq(purchases.merchantSessionId, row.id)),
	]
	const purchaseRows = conditions.length
		? await db
				.select({ id: purchases.id })
				.from(purchases)
				.where(or(...conditions))
		: []
	return {
		chargeIds: chargeRows.map((row) => row.id),
		merchantSessionIds: sessionRows.map((row) => row.id),
		purchaseIds: [...new Set(purchaseRows.map((row) => row.id))],
	}
}

const LOOKUP_BATCH = 100

/**
 * Returns the checkout session ids that already have a purchase.
 *
 * The adapter writes the merchant charge, merchant session and purchase in
 * one transaction. The charge lookup uses indexed columns
 * (`MerchantCharge.identifier`, `Purchase.merchantChargeId`), so it answers
 * the normal case cheaply. Only sessions it cannot place fall through to the
 * merchant session lookup, which normally means none.
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
		.map((session) => session.checkoutSessionId)
		.filter((id) => !fulfilled.has(id))
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
