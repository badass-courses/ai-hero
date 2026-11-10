export const EARLY_ACCESS_REVOKE_EVENT = 'aihero/early-access.revoke' as const
export type EarlyAccessRevoke = {
	name: typeof EARLY_ACCESS_REVOKE_EVENT
	data: { purchaseId: string; invoiceId: string }
}
