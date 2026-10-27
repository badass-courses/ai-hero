/** Shared by app entitlement operations and DB-only maintenance commands. */
export enum EntitlementSourceType {
	PURCHASE = 'PURCHASE',
	SUBSCRIPTION = 'SUBSCRIPTION',
	MANUAL = 'MANUAL',
	COUPON = 'COUPON',
}
