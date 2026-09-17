/**
 * Completion gate for purchase transfers (AIH-223 / AIH-209).
 *
 * A transfer may only move VERIFIED -> COMPLETED when the target's world
 * actually agrees: purchase ownership, personal organization, membership,
 * learner role, purchase organization, and access to every transferred
 * resource. The gate is a pure function over a snapshot so it can be tested
 * without a database; the workflow gathers the snapshot and refuses
 * completion on any mismatch.
 *
 * Access is verified per required (entitlement type, resource) pair rather
 * than by counting rows. Counting is wrong in two real cases:
 *
 * - `createResourceEntitlements` skips minting when the target already holds
 *   active access to a resource from another purchase, so a retry must
 *   converge on that existing access instead of demanding a new row sourced
 *   from the current purchase.
 * - The archive path moves an arbitrary number of archive-derived rows, so
 *   there is no fixed expected count.
 */

export interface RequiredTargetAccess {
	entitlementTypeId: string
	/**
	 * Content resource the satisfying entitlement must list in
	 * `metadata.contentIds`. `null` means the requirement is not keyed to a
	 * resource (Discord role, archive-derived rows) and is satisfied only by
	 * an active row of this type sourced from the current purchase.
	 */
	resourceId: string | null
}

export interface TargetEntitlementRow {
	id: string
	entitlementTypeId: string
	sourceId: string | null
	organizationId: string | null
	organizationMembershipId: string | null
	contentIds: string[]
}

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
	/** The target's membership in that organization, as resolved by the workflow. */
	expectedMembershipId: string | null
	/** Membership rows for the target user in the expected organization. */
	targetMembership: { id: string; organizationId: string | null } | null
	/** Active role names on that membership. */
	targetMembershipRoleNames: string[]
	/** Every (entitlement type, resource) pair the transfer had to grant. */
	requiredTargetAccess: RequiredTargetAccess[]
	/**
	 * Active target rows sourced from the current purchase that already sit in
	 * the expected organization and membership (the workflow filters by both).
	 */
	activeTargetEntitlements: TargetEntitlementRow[]
	/**
	 * Active target rows sourced from the current purchase that live outside
	 * the expected organization or membership. Never satisfy access; each one
	 * is a failure.
	 */
	misplacedTargetEntitlements: TargetEntitlementRow[]
	/**
	 * Active target rows from any other source (another purchase, coupon,
	 * subscription). These mirror the duplicate check in
	 * `createResourceEntitlements`, which skips minting when the target
	 * already holds access to a resource, so they may satisfy resource-keyed
	 * requirements.
	 */
	existingTargetAccess: TargetEntitlementRow[]
	/** Active (not soft-deleted) purchase-sourced source-user entitlements. */
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
	| {
			ok: false
			failures: string[]
			/** Requirements no active row satisfied; empty unless access failed. */
			missingAccess: RequiredTargetAccess[]
	  }

/**
 * Resources `createResourceEntitlements` grants content access to for a
 * product resource. Mirrors that function exactly: a cohort grants one row
 * per attached workshop resource (never reminder emails or null resources),
 * a self-paced product grants one row for the workshop itself.
 */
export function listRequiredContentResourceIds(
	productType: string,
	resource: {
		id: string
		resources?: Array<{ resource?: { id: string; type?: string } | null }>
	},
): string[] {
	if (productType === 'cohort') {
		return (resource.resources ?? [])
			.map((item) => item.resource)
			.filter(
				(child): child is { id: string; type?: string } =>
					Boolean(child) && child?.type === 'workshop',
			)
			.map((child) => child.id)
	}
	return [resource.id]
}

/** Normalize `metadata.contentIds` from an entitlement row into a string list. */
export function readContentIds(metadata: unknown): string[] {
	if (!metadata || typeof metadata !== 'object') return []
	const contentIds = (metadata as { contentIds?: unknown }).contentIds
	if (!Array.isArray(contentIds)) return []
	return contentIds.filter((id): id is string => typeof id === 'string')
}

function satisfies(
	requirement: RequiredTargetAccess,
	row: TargetEntitlementRow,
	currentPurchaseId: string,
): boolean {
	if (row.entitlementTypeId !== requirement.entitlementTypeId) return false
	if (requirement.resourceId === null) {
		return row.sourceId === currentPurchaseId
	}
	return row.contentIds.includes(requirement.resourceId)
}

export function verifyTransferCompletionInvariants(
	snapshot: TransferCompletionSnapshot,
): TransferCompletionVerdict {
	const failures: string[] = []
	const missingAccess: RequiredTargetAccess[] = []

	if (!snapshot.purchase) {
		return { ok: false, failures: ['purchase_missing'], missingAccess }
	}
	const currentPurchaseId = snapshot.purchase.id

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
		// Current-purchase rows only count when they sit in the expected
		// organization and membership. The workflow already filters the query
		// that way; the misplaced list names what the filter excluded.
		const verifiedCurrent = snapshot.activeTargetEntitlements.filter(
			(row) =>
				row.sourceId === currentPurchaseId &&
				row.organizationId === snapshot.expectedOrganizationId &&
				row.organizationMembershipId === snapshot.expectedMembershipId,
		)
		const misplaced = [
			...snapshot.misplacedTargetEntitlements,
			...snapshot.activeTargetEntitlements.filter(
				(row) => !verifiedCurrent.includes(row),
			),
		]
		if (
			misplaced.some(
				(row) => row.organizationId !== snapshot.expectedOrganizationId,
			)
		) {
			failures.push('target_entitlement_wrong_organization')
		}
		if (
			misplaced.some(
				(row) =>
					row.organizationId === snapshot.expectedOrganizationId &&
					row.organizationMembershipId !== snapshot.expectedMembershipId,
			)
		) {
			failures.push('target_entitlement_wrong_membership')
		}

		// Existing access from another source never doubles as a current
		// purchase row, so a misplaced current row cannot sneak back in here.
		const existing = snapshot.existingTargetAccess.filter(
			(row) => row.sourceId !== currentPurchaseId,
		)

		for (const requirement of snapshot.requiredTargetAccess) {
			const met =
				verifiedCurrent.some((row) =>
					satisfies(requirement, row, currentPurchaseId),
				) ||
				existing.some((row) => satisfies(requirement, row, currentPurchaseId))
			if (!met) missingAccess.push(requirement)
		}
		if (missingAccess.length > 0) {
			failures.push('target_entitlements_missing')
		}

		if (snapshot.activeSourceEntitlementCount > 0) {
			failures.push('source_entitlements_still_active')
		}
	}

	return failures.length > 0
		? { ok: false, failures, missingAccess }
		: { ok: true }
}
