/**
 * Completion gate for purchase transfers (AIH-223 / AIH-209).
 *
 * A transfer may only move VERIFIED -> COMPLETED when the target's world
 * actually agrees: purchase ownership, personal organization, membership,
 * learner role, purchase organization, and active entitlements. The gate is
 * a pure function over a snapshot so it can be tested without a database;
 * the workflow gathers the snapshot and refuses completion on any mismatch.
 */

export interface TransferCompletionSnapshot {
	purchase: {
		id: string
		userId: string | null
		organizationId: string | null
	} | null
	targetUserId: string
	sourceUserId: string
	/** The target's personal organization the workflow moved the purchase into. */
	expectedOrganizationId: string | null
	/** Membership rows for the target user in the expected organization. */
	targetMembership: { id: string; organizationId: string | null } | null
	/** Active role names on that membership. */
	targetMembershipRoleNames: string[]
	/** Active (not soft-deleted) purchase-sourced entitlements. */
	activeTargetEntitlementCount: number
	activeSourceEntitlementCount: number
	/**
	 * Full entitlement/organization checks only apply to individual
	 * transferable purchases; team purchases and non-entitlement products
	 * check ownership only.
	 */
	requiresOrganizationChecks: boolean
	requiresEntitlementChecks: boolean
}

export type TransferCompletionVerdict =
	| { ok: true }
	| { ok: false; failures: string[] }

export function verifyTransferCompletionInvariants(
	snapshot: TransferCompletionSnapshot,
): TransferCompletionVerdict {
	const failures: string[] = []

	if (!snapshot.purchase) {
		return { ok: false, failures: ['purchase_missing'] }
	}

	if (snapshot.purchase.userId !== snapshot.targetUserId) {
		failures.push('purchase_owner_mismatch')
	}

	if (snapshot.requiresOrganizationChecks) {
		if (!snapshot.expectedOrganizationId) {
			failures.push('target_personal_organization_missing')
		}
		if (
			snapshot.expectedOrganizationId &&
			snapshot.purchase.organizationId !== snapshot.expectedOrganizationId
		) {
			failures.push('purchase_organization_mismatch')
		}
		if (!snapshot.targetMembership) {
			failures.push('target_membership_missing')
		} else if (
			snapshot.expectedOrganizationId &&
			snapshot.targetMembership.organizationId !==
				snapshot.expectedOrganizationId
		) {
			failures.push('target_membership_wrong_organization')
		}
		if (!snapshot.targetMembershipRoleNames.includes('learner')) {
			failures.push('target_learner_role_missing')
		}
	}

	if (snapshot.requiresEntitlementChecks) {
		if (snapshot.activeTargetEntitlementCount < 1) {
			failures.push('target_entitlements_missing')
		}
		if (snapshot.activeSourceEntitlementCount > 0) {
			failures.push('source_entitlements_still_active')
		}
	}

	return failures.length > 0 ? { ok: false, failures } : { ok: true }
}
