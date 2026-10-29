import { EntitlementSourceType } from '@/lib/entitlement-source-type'

type RoleEntitlement = {
	id: string
	entitlementType?: string
	sourceType: string
	sourceId: string
	metadata?: { discordRoleId?: unknown } | null
}

/**
 * Splits the refunded purchase's Discord role entitlements into roles to
 * remove and roles to keep. A role is kept when any live entitlement from
 * another source still grants it. Entitlements sourced from the refunded
 * purchase never count, so the decision doesn't depend on whether
 * refund-entitlements has soft-deleted them yet.
 */
export function partitionDiscordRoleRemovals({
	refundedPurchaseId,
	refundedEntitlements,
	liveEntitlements,
}: {
	refundedPurchaseId: string
	refundedEntitlements: RoleEntitlement[]
	liveEntitlements: RoleEntitlement[]
}) {
	const retained = new Set<string>()
	for (const live of liveEntitlements) {
		if (
			live.sourceType === EntitlementSourceType.PURCHASE &&
			live.sourceId === refundedPurchaseId
		)
			continue
		const roleId = live.metadata?.discordRoleId
		if (typeof roleId === 'string' && roleId) retained.add(roleId)
	}

	const remove: { entitlementId: string; discordRoleId: string }[] = []
	const keep: { entitlementId: string; discordRoleId: string }[] = []
	for (const entitlement of refundedEntitlements) {
		const roleId = entitlement.metadata?.discordRoleId
		if (typeof roleId !== 'string' || !roleId) continue
		const target = { entitlementId: entitlement.id, discordRoleId: roleId }
		if (retained.has(roleId)) keep.push(target)
		else remove.push(target)
	}
	return { remove, keep }
}
