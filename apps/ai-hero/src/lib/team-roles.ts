export const BILLING_ADMIN_ROLE = 'billing_admin' as const

const TEAM_PURCHASE_MANAGER_ROLES = new Set<string>([
	'owner',
	BILLING_ADMIN_ROLE,
])

export function isTeamPurchaseManagerRole(roleName: string): boolean {
	return TEAM_PURCHASE_MANAGER_ROLES.has(roleName)
}
