import { describe, expect, it } from 'vitest'

import {
	verifyTransferCompletionInvariants,
	type TransferCompletionSnapshot,
} from './transfer-completion'

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
	targetMembership: { id: 'member_1', organizationId: 'org_target' },
	targetMembershipRoleNames: ['learner'],
	activeTargetEntitlementCount: 2,
	activeSourceEntitlementCount: 0,
	requiresOrganizationChecks: true,
	requiresEntitlementChecks: true,
	...overrides,
})

describe('verifyTransferCompletionInvariants', () => {
	it('passes when every dimension agrees', () => {
		expect(verifyTransferCompletionInvariants(agreeingSnapshot())).toEqual({
			ok: true,
		})
	})

	it('fails when the purchase row is missing', () => {
		expect(
			verifyTransferCompletionInvariants(agreeingSnapshot({ purchase: null })),
		).toEqual({ ok: false, failures: ['purchase_missing'] })
	})

	it('fails when the purchase still belongs to the source user', () => {
		const verdict = verifyTransferCompletionInvariants(
			agreeingSnapshot({
				purchase: {
					id: 'purchase_1',
					userId: 'user_source',
					organizationId: 'org_target',
				},
			}),
		)
		expect(verdict.ok).toBe(false)
		expect(verdict.ok ? [] : verdict.failures).toContain(
			'purchase_owner_mismatch',
		)
	})

	it('fails when the target personal organization is missing', () => {
		const verdict = verifyTransferCompletionInvariants(
			agreeingSnapshot({ expectedOrganizationId: null }),
		)
		expect(verdict.ok ? [] : verdict.failures).toContain(
			'target_personal_organization_missing',
		)
	})

	it('fails when the purchase sits in the wrong organization', () => {
		const verdict = verifyTransferCompletionInvariants(
			agreeingSnapshot({
				purchase: {
					id: 'purchase_1',
					userId: 'user_target',
					organizationId: 'org_source',
				},
			}),
		)
		expect(verdict.ok ? [] : verdict.failures).toContain(
			'purchase_organization_mismatch',
		)
	})

	it('fails when the target has no membership in the expected organization', () => {
		const verdict = verifyTransferCompletionInvariants(
			agreeingSnapshot({ targetMembership: null }),
		)
		expect(verdict.ok ? [] : verdict.failures).toContain(
			'target_membership_missing',
		)
	})

	it('fails when the membership belongs to a different organization', () => {
		const verdict = verifyTransferCompletionInvariants(
			agreeingSnapshot({
				targetMembership: { id: 'member_1', organizationId: 'org_other' },
			}),
		)
		expect(verdict.ok ? [] : verdict.failures).toContain(
			'target_membership_wrong_organization',
		)
	})

	it('fails when the learner role is missing', () => {
		const verdict = verifyTransferCompletionInvariants(
			agreeingSnapshot({ targetMembershipRoleNames: ['admin'] }),
		)
		expect(verdict.ok ? [] : verdict.failures).toContain(
			'target_learner_role_missing',
		)
	})

	it('fails when the target has no active entitlements', () => {
		const verdict = verifyTransferCompletionInvariants(
			agreeingSnapshot({ activeTargetEntitlementCount: 0 }),
		)
		expect(verdict.ok ? [] : verdict.failures).toContain(
			'target_entitlements_missing',
		)
	})

	it('fails when the source still holds active entitlements', () => {
		const verdict = verifyTransferCompletionInvariants(
			agreeingSnapshot({ activeSourceEntitlementCount: 1 }),
		)
		expect(verdict.ok ? [] : verdict.failures).toContain(
			'source_entitlements_still_active',
		)
	})

	it('accumulates every disagreement instead of stopping at the first', () => {
		const verdict = verifyTransferCompletionInvariants(
			agreeingSnapshot({
				purchase: {
					id: 'purchase_1',
					userId: 'user_source',
					organizationId: 'org_source',
				},
				targetMembership: null,
				targetMembershipRoleNames: [],
				activeTargetEntitlementCount: 0,
				activeSourceEntitlementCount: 3,
			}),
		)
		expect(verdict.ok).toBe(false)
		expect(verdict.ok ? [] : verdict.failures).toEqual([
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
					targetMembership: null,
					targetMembershipRoleNames: [],
					activeTargetEntitlementCount: 0,
					requiresOrganizationChecks: false,
					requiresEntitlementChecks: false,
				}),
			),
		).toEqual({ ok: true })
	})
})
