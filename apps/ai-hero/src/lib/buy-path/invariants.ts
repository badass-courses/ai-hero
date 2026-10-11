import type { BuyPathEvent } from './schema'
export type InvariantField = NonNullable<BuyPathEvent['field']>
export type PurchaseSnapshot = {
	buyPathId: string
	purchaseId: string | null
	productId: string | null
	userId: string | null
	exists: boolean
	status: string | null
	entitlementCount: number
	expectedEntitlementCount: number
	totalCents: number | null
	chargeCents: number | null
	requiresCharge: boolean
}
export type InvariantCheck = {
	field: InvariantField
	check: (snapshot: PurchaseSnapshot) => boolean | Promise<boolean>
}
export const purchaseInvariantChecks: readonly InvariantCheck[] = [
	{ field: 'purchase', check: (s) => s.exists },
	{
		field: 'status',
		check: (s) => ['Valid', 'Restricted'].includes(s.status ?? ''),
	},
	{
		field: 'entitlements',
		check: (s) => s.entitlementCount >= s.expectedEntitlementCount,
	},
	{
		field: 'charge',
		check: (s) => !s.requiresCharge || s.chargeCents !== null,
	},
	{
		field: 'amount',
		check: (s) =>
			!s.requiresCharge ||
			(s.totalCents !== null &&
				s.chargeCents !== null &&
				s.totalCents === s.chargeCents),
	},
]
/** DESK HOOK: append {field:'decision', check} once PurchaseDecision lands.
 * Do not read mutable legacy Purchase.fields or call it verified in the meantime.
 */
export const purchaseDecisionInvariantChecks: readonly InvariantCheck[] = []
export async function checkPurchaseInvariants(
	snapshot: PurchaseSnapshot,
	checks: readonly InvariantCheck[],
	emitFailure: (field: InvariantField) => Promise<void>,
) {
	const failures: InvariantField[] = []
	for (const { field, check } of checks) {
		let ok = false
		try {
			ok = await check(snapshot)
		} catch {
			/* A failed read is not a passed invariant. */
		}
		if (!ok) {
			failures.push(field)
			await emitFailure(field)
		}
	}
	return failures
}
