import { describe, expect, it } from 'vitest'

import {
	listRequiredContentResourceIds,
	readContentIds,
	verifyTransferCompletionInvariants,
	type TargetEntitlementRow,
	type TransferCompletionSnapshot,
} from './transfer-completion'

const CONTENT = 'cohort_content_access'
const DISCORD = 'cohort_discord_role'

const currentRow = (
	overrides: Partial<TargetEntitlementRow> = {},
): TargetEntitlementRow => ({
	id: 'ent_current',
	entitlementTypeId: CONTENT,
	sourceId: 'purchase_1',
	organizationId: 'org_target',
	organizationMembershipId: 'member_1',
	contentIds: ['workshop_1'],
	...overrides,
})

const agreeingSnapshot = (
	overrides: Partial<TransferCompletionSnapshot> = {},
): TransferCompletionSnapshot => ({
	purchase: {
		id: 'purchase_1',
		userId: 'user_target',
		organizationId: 'org_target',
	},
	targetUserId: 'user_target',
	sourceUserId: 'user_source',
	expectedOrganizationId: 'org_target',
	expectedMembershipId: 'member_1',
	targetMembership: { id: 'member_1', organizationId: 'org_target' },
	targetMembershipRoleNames: ['learner'],
	requiredTargetAccess: [
		{ entitlementTypeId: CONTENT, resourceId: 'workshop_1' },
		{ entitlementTypeId: DISCORD, resourceId: null },
	],
	activeTargetEntitlements: [
		currentRow(),
		currentRow({
			id: 'ent_discord',
			entitlementTypeId: DISCORD,
			contentIds: [],
		}),
	],
	misplacedTargetEntitlements: [],
	existingTargetAccess: [],
	activeSourceEntitlementCount: 0,
	requiresOrganizationChecks: true,
	requiresEntitlementChecks: true,
	...overrides,
})

const failuresOf = (snapshot: TransferCompletionSnapshot) => {
	const verdict = verifyTransferCompletionInvariants(snapshot)
	return verdict.ok ? [] : verdict.failures
}

describe('verifyTransferCompletionInvariants', () => {
	it('passes when every dimension agrees', () => {
		expect(verifyTransferCompletionInvariants(agreeingSnapshot())).toEqual({
			ok: true,
		})
	})

	it('fails when the purchase row is missing', () => {
		expect(
			verifyTransferCompletionInvariants(agreeingSnapshot({ purchase: null })),
		).toEqual({ ok: false, failures: ['purchase_missing'], missingAccess: [] })
	})

	it('fails when the purchase still belongs to the source user', () => {
		expect(
			failuresOf(
				agreeingSnapshot({
					purchase: {
						id: 'purchase_1',
						userId: 'user_source',
						organizationId: 'org_target',
					},
				}),
			),
		).toContain('purchase_owner_mismatch')
	})

	it('fails when the target personal organization is missing', () => {
		expect(
			failuresOf(agreeingSnapshot({ expectedOrganizationId: null })),
		).toContain('target_personal_organization_missing')
	})

	it('fails when the purchase sits in the wrong organization', () => {
		expect(
			failuresOf(
				agreeingSnapshot({
					purchase: {
						id: 'purchase_1',
						userId: 'user_target',
						organizationId: 'org_source',
					},
				}),
			),
		).toContain('purchase_organization_mismatch')
	})

	it('fails when the target has no membership in the expected organization', () => {
		expect(failuresOf(agreeingSnapshot({ targetMembership: null }))).toContain(
			'target_membership_missing',
		)
	})

	it('fails when the membership belongs to a different organization', () => {
		expect(
			failuresOf(
				agreeingSnapshot({
					targetMembership: { id: 'member_1', organizationId: 'org_other' },
				}),
			),
		).toContain('target_membership_wrong_organization')
	})

	it('fails when the learner role is missing', () => {
		expect(
			failuresOf(agreeingSnapshot({ targetMembershipRoleNames: ['admin'] })),
		).toContain('target_learner_role_missing')
	})

	it('fails when the target has no active entitlements at all', () => {
		const verdict = verifyTransferCompletionInvariants(
			agreeingSnapshot({ activeTargetEntitlements: [] }),
		)
		expect(verdict.ok).toBe(false)
		if (verdict.ok) return
		expect(verdict.failures).toContain('target_entitlements_missing')
		expect(verdict.missingAccess).toEqual([
			{ entitlementTypeId: CONTENT, resourceId: 'workshop_1' },
			{ entitlementTypeId: DISCORD, resourceId: null },
		])
	})

	it('fails when one required resource is missing even though another row of the same type exists', () => {
		const verdict = verifyTransferCompletionInvariants(
			agreeingSnapshot({
				requiredTargetAccess: [
					{ entitlementTypeId: CONTENT, resourceId: 'workshop_1' },
					{ entitlementTypeId: CONTENT, resourceId: 'workshop_2' },
				],
				activeTargetEntitlements: [currentRow()],
			}),
		)
		expect(verdict.ok).toBe(false)
		if (verdict.ok) return
		expect(verdict.failures).toEqual(['target_entitlements_missing'])
		expect(verdict.missingAccess).toEqual([
			{ entitlementTypeId: CONTENT, resourceId: 'workshop_2' },
		])
	})

	it('does not compare raw counts: extra rows never mask a missing resource', () => {
		expect(
			failuresOf(
				agreeingSnapshot({
					requiredTargetAccess: [
						{ entitlementTypeId: CONTENT, resourceId: 'workshop_2' },
					],
					activeTargetEntitlements: [
						currentRow({ id: 'a' }),
						currentRow({ id: 'b' }),
						currentRow({ id: 'c' }),
					],
				}),
			),
		).toEqual(['target_entitlements_missing'])
	})

	it('accepts verified existing access from another purchase for a resource-keyed requirement', () => {
		expect(
			verifyTransferCompletionInvariants(
				agreeingSnapshot({
					requiredTargetAccess: [
						{ entitlementTypeId: CONTENT, resourceId: 'workshop_1' },
					],
					activeTargetEntitlements: [],
					existingTargetAccess: [
						currentRow({
							id: 'ent_other',
							sourceId: 'purchase_other',
							organizationId: 'org_team',
							organizationMembershipId: 'member_team',
						}),
					],
				}),
			),
		).toEqual({ ok: true })
	})

	it('never lets existing access satisfy a purchase-keyed requirement', () => {
		expect(
			failuresOf(
				agreeingSnapshot({
					requiredTargetAccess: [
						{ entitlementTypeId: DISCORD, resourceId: null },
					],
					activeTargetEntitlements: [],
					existingTargetAccess: [
						currentRow({
							id: 'ent_other',
							entitlementTypeId: DISCORD,
							sourceId: 'purchase_other',
							contentIds: [],
						}),
					],
				}),
			),
		).toEqual(['target_entitlements_missing'])
	})

	it('ignores a current-purchase row that leaked into the existing-access list', () => {
		expect(
			failuresOf(
				agreeingSnapshot({
					requiredTargetAccess: [
						{ entitlementTypeId: CONTENT, resourceId: 'workshop_1' },
					],
					activeTargetEntitlements: [],
					existingTargetAccess: [currentRow({ organizationId: 'org_wrong' })],
				}),
			),
		).toEqual(['target_entitlements_missing'])
	})

	it('fails when a current-purchase row sits in the wrong organization', () => {
		const verdict = verifyTransferCompletionInvariants(
			agreeingSnapshot({
				requiredTargetAccess: [
					{ entitlementTypeId: CONTENT, resourceId: 'workshop_1' },
				],
				activeTargetEntitlements: [],
				misplacedTargetEntitlements: [
					currentRow({ organizationId: 'org_wrong' }),
				],
			}),
		)
		expect(verdict.ok).toBe(false)
		if (verdict.ok) return
		expect(verdict.failures).toEqual([
			'target_entitlement_wrong_organization',
			'target_entitlements_missing',
		])
	})

	it('fails when a current-purchase row sits on the wrong membership', () => {
		expect(
			failuresOf(
				agreeingSnapshot({
					requiredTargetAccess: [
						{ entitlementTypeId: CONTENT, resourceId: 'workshop_1' },
					],
					activeTargetEntitlements: [],
					misplacedTargetEntitlements: [
						currentRow({ organizationMembershipId: 'member_wrong' }),
					],
				}),
			),
		).toEqual([
			'target_entitlement_wrong_membership',
			'target_entitlements_missing',
		])
	})

	it('re-checks organization and membership on rows the workflow already filtered', () => {
		expect(
			failuresOf(
				agreeingSnapshot({
					requiredTargetAccess: [
						{ entitlementTypeId: CONTENT, resourceId: 'workshop_1' },
					],
					activeTargetEntitlements: [
						currentRow({ organizationMembershipId: 'member_wrong' }),
					],
				}),
			),
		).toEqual([
			'target_entitlement_wrong_membership',
			'target_entitlements_missing',
		])
	})

	it('fails when the source still holds active entitlements', () => {
		expect(
			failuresOf(agreeingSnapshot({ activeSourceEntitlementCount: 1 })),
		).toContain('source_entitlements_still_active')
	})

	it('accumulates every disagreement instead of stopping at the first', () => {
		expect(
			failuresOf(
				agreeingSnapshot({
					purchase: {
						id: 'purchase_1',
						userId: 'user_source',
						organizationId: 'org_source',
					},
					targetMembership: null,
					targetMembershipRoleNames: [],
					activeTargetEntitlements: [],
					activeSourceEntitlementCount: 3,
				}),
			),
		).toEqual([
			'purchase_owner_mismatch',
			'purchase_organization_mismatch',
			'target_membership_missing',
			'target_learner_role_missing',
			'target_entitlements_missing',
			'source_entitlements_still_active',
		])
	})

	it('checks ownership only for team purchases and non-entitlement products', () => {
		expect(
			verifyTransferCompletionInvariants(
				agreeingSnapshot({
					expectedOrganizationId: null,
					expectedMembershipId: null,
					targetMembership: null,
					targetMembershipRoleNames: [],
					activeTargetEntitlements: [],
					requiresOrganizationChecks: false,
					requiresEntitlementChecks: false,
				}),
			),
		).toEqual({ ok: true })
	})
})

describe('listRequiredContentResourceIds', () => {
	it('lists only workshop children for a cohort, skipping emails and null resources', () => {
		expect(
			listRequiredContentResourceIds('cohort', {
				id: 'cohort_1',
				resources: [
					{ resource: { id: 'workshop_1', type: 'workshop' } },
					{ resource: { id: 'email_1', type: 'email' } },
					{ resource: null },
					{ resource: { id: 'workshop_2', type: 'workshop' } },
				],
			}),
		).toEqual(['workshop_1', 'workshop_2'])
	})

	it('returns an empty list for a cohort with no attached workshops', () => {
		expect(
			listRequiredContentResourceIds('cohort', { id: 'cohort_1' }),
		).toEqual([])
	})

	it('uses the resource itself for self-paced products', () => {
		expect(
			listRequiredContentResourceIds('self-paced', { id: 'workshop_9' }),
		).toEqual(['workshop_9'])
	})
})

describe('readContentIds', () => {
	it('reads string ids and ignores malformed metadata', () => {
		expect(readContentIds({ contentIds: ['a', 1, null, 'b'] })).toEqual([
			'a',
			'b',
		])
		expect(readContentIds({ contentIds: 'a' })).toEqual([])
		expect(readContentIds(null)).toEqual([])
		expect(readContentIds('junk')).toEqual([])
	})
})
