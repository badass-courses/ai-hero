import { describe, expect, it } from 'vitest'

import {
	CRASH_COURSE_PPP_ALUMNI_MIGRATION,
	buildCrashCoursePppAlumniPlan,
	deterministicPppAlumniEntitlementId,
	parseCrashCoursePppAlumniBackfillArgs,
	resolveCrashCoursePppAlumniMembership,
	selectCrashCoursePppAlumniPlanWindow,
	validateCrashCoursePppAlumniAppliedWindow,
	validateCrashCoursePppAlumniApplyApproval,
	validateCrashCoursePppAlumniCouponContracts,
	type AlumniCouponContractRecord,
	type AlumniEntitlementRecord,
	type AlumniPurchaseRecord,
} from './crash-course-ppp-alumni-backfill'

const migration = CRASH_COURSE_PPP_ALUMNI_MIGRATION

const purchase = (
	overrides: Partial<AlumniPurchaseRecord> = {},
): AlumniPurchaseRecord => ({
	id: 'purchase-1',
	userId: 'user-1',
	userExists: true,
	userEmail: 'learner@example.com',
	productId: 'product-3vfob',
	status: 'Restricted',
	totalAmount: '99',
	bulkCouponId: null,
	createdAt: new Date('2026-03-01T00:00:00.000Z'),
	organizationId: 'org-1',
	organizationMembershipId: 'membership-1',
	...overrides,
})

const entitlement = (
	overrides: Partial<AlumniEntitlementRecord> = {},
): AlumniEntitlementRecord => ({
	id: 'entitlement-1',
	userId: 'user-1',
	sourceId: migration.sourceProductCoupons['product-3vfob'],
	entitlementType: 'special-credit-type',
	sourceType: 'COUPON',
	organizationId: 'org-1',
	organizationMembershipId: 'membership-1',
	metadata: {},
	deletedAt: null,
	...overrides,
})

const migrationEntitlement = (
	overrides: Partial<AlumniEntitlementRecord> = {},
): AlumniEntitlementRecord =>
	entitlement({
		id: deterministicPppAlumniEntitlementId('user-1'),
		metadata: {
			migrationId: migration.migrationId,
			eligibilityProductId: 'product-3vfob',
			sourcePurchaseId: 'purchase-1',
			targetProductId: migration.targetProductId,
			creditAmountCents: migration.creditAmountCents,
			policy: 'official_ppp_prior_cohort_alumni',
		},
		...overrides,
	})

const couponContracts = (): AlumniCouponContractRecord[] =>
	Object.entries(migration.sourceProductCoupons).map(
		([sourceProductId, couponId]) => ({
			couponId,
			sourceProductId,
			couponStatus: 1,
			couponAmountDiscount: migration.creditAmountCents,
			restrictedToProductId: migration.targetProductId,
			merchantCouponId: `merchant-${sourceProductId}`,
			merchantCouponStatus: 1,
			merchantCouponAmountDiscount: migration.creditAmountCents,
			merchantCouponType: 'special credit',
			couponExclusive: true,
			couponStackable: false,
			couponExpiresAt: null,
			couponMaxUses: -1,
			couponUsedCount: 0,
			eligibilityCondition: {
				type: 'hasValidProductPurchase',
				productId: sourceProductId,
			},
		}),
	)

const buildPlan = (
	input: Omit<
		Parameters<typeof buildCrashCoursePppAlumniPlan>[0],
		'entitlementTypeId'
	>,
) =>
	buildCrashCoursePppAlumniPlan({
		...input,
		entitlementTypeId: 'special-credit-type',
	})

describe('Crash Course PPP alumni backfill planning', () => {
	it('selects one newest qualifying cohort purchase per user', () => {
		const plan = buildPlan({
			purchases: [
				purchase({ id: 'purchase-c1', productId: 'product-3vfob' }),
				purchase({
					id: 'purchase-c3',
					productId: 'product-7t9ek',
					createdAt: new Date('2026-04-01T00:00:00.000Z'),
				}),
			],
			entitlements: [],
		})

		expect(plan.approvedEntries).toHaveLength(1)
		expect(plan.approvedEntries[0]).toMatchObject({
			status: 'pending',
			sourcePurchaseId: 'purchase-c3',
			sourceProductId: 'product-7t9ek',
			targetCouponId: migration.sourceProductCoupons['product-7t9ek'],
		})
	})

	it('ignores ineligible, post-cutoff, zero-value, and bulk purchases', () => {
		const plan = buildPlan({
			purchases: [
				purchase({ id: 'valid', status: 'Valid' }),
				purchase({ id: 'zero', userId: 'user-2', totalAmount: '0' }),
				purchase({
					id: 'bulk',
					userId: 'user-3',
					bulkCouponId: 'bulk-1',
				}),
				purchase({
					id: 'late',
					userId: 'user-4',
					createdAt: new Date('2026-08-15T00:00:00.000Z'),
				}),
			],
			entitlements: [],
		})

		expect(plan.approvedEntries).toEqual([])
	})

	it('excludes users who already had any active alumni credit', () => {
		const plan = buildPlan({
			purchases: [purchase()],
			entitlements: [entitlement()],
		})

		expect(plan.approvedEntries).toEqual([])
		expect(plan.excludedPreexistingEntitlementCount).toBe(1)
	})

	it('keeps migration-owned entitlements in the stable approved set', () => {
		const initial = buildPlan({
			purchases: [purchase()],
			entitlements: [],
		})
		const applied = buildPlan({
			purchases: [purchase()],
			entitlements: [migrationEntitlement()],
		})

		expect(initial.approvedEntries[0]?.status).toBe('pending')
		expect(applied.approvedEntries[0]?.status).toBe('already_applied')
		expect(applied.fingerprint).toBe(initial.fingerprint)
		expect(applied.counts).toMatchObject({
			approved: 1,
			pending: 0,
			alreadyApplied: 1,
		})
	})

	it('blocks missing user, email, organization, or membership data', () => {
		const plan = buildPlan({
			purchases: [
				purchase({
					userExists: false,
					userEmail: null,
					organizationId: null,
					organizationMembershipId: null,
				}),
			],
			entitlements: [],
		})

		expect(plan.counts.blocked).toBe(1)
		expect(plan.blockers.map((blocker) => blocker.reason)).toEqual([
			'missing_user',
			'missing_email',
			'missing_organization',
			'missing_organization_membership',
		])
	})

	it('blocks otherwise qualifying purchases with no user id', () => {
		const plan = buildPlan({
			purchases: [purchase({ userId: null, userExists: false })],
			entitlements: [],
		})

		expect(plan.approvedEntries).toEqual([])
		expect(plan.counts.blocked).toBe(1)
		expect(plan.blockers).toEqual([{ userId: null, reason: 'missing_user_id' }])
	})

	it('blocks a migration entitlement combined with another alumni credit', () => {
		const plan = buildPlan({
			purchases: [purchase()],
			entitlements: [
				migrationEntitlement(),
				entitlement({
					id: 'foreign-credit',
					sourceId: migration.sourceProductCoupons['product-wdhub'],
				}),
			],
		})

		expect(plan.approvedEntries[0]?.status).toBe('already_applied')
		expect(plan.approvedEntries[0]?.blockerReasons).toContain(
			'conflicting_active_entitlement',
		)
	})

	it('blocks malformed migration-owned entitlement rows', () => {
		const plan = buildPlan({
			purchases: [purchase()],
			entitlements: [
				migrationEntitlement({
					sourceId: 'coupon_wrong',
				}),
			],
		})

		expect(plan.approvedEntries[0]?.status).toBe('already_applied')
		expect(plan.approvedEntries[0]?.blockerReasons).toContain(
			'invalid_migration_entitlement',
		)
	})

	it('requires every selected window entry to read back as applied', () => {
		const before = buildPlan({
			purchases: [purchase()],
			entitlements: [],
		}).approvedEntries
		const afterPending = buildPlan({
			purchases: [purchase()],
			entitlements: [],
		}).approvedEntries
		const afterApplied = buildPlan({
			purchases: [purchase()],
			entitlements: [migrationEntitlement()],
		}).approvedEntries

		expect(
			validateCrashCoursePppAlumniAppliedWindow(before, afterPending),
		).toEqual({ ok: false, failedPositions: [0] })
		expect(
			validateCrashCoursePppAlumniAppliedWindow(before, afterApplied),
		).toEqual({ ok: true, failedPositions: [] })
	})

	it('uses a stable bounded entitlement id', () => {
		const first = deterministicPppAlumniEntitlementId('user-1')
		const second = deterministicPppAlumniEntitlementId('user-1')

		expect(first).toBe(second)
		expect(first).not.toBe(deterministicPppAlumniEntitlementId('user-2'))
		expect(first.length).toBeLessThanOrEqual(191)
	})
})

describe('Crash Course PPP alumni organization selection', () => {
	it('prefers the exact personal organization over team memberships', () => {
		expect(
			resolveCrashCoursePppAlumniMembership({
				userEmail: 'learner@example.com',
				purchaseOrganizationId: 'team-org',
				memberships: [
					{
						id: 'team-membership',
						organizationId: 'team-org',
						organizationName: 'A Team',
					},
					{
						id: 'personal-membership',
						organizationId: 'personal-org',
						organizationName: 'Personal (learner@example.com)',
					},
				],
			}),
		).toEqual({
			id: 'personal-membership',
			organizationId: 'personal-org',
			organizationName: 'Personal (learner@example.com)',
		})
	})

	it('uses a purchase-linked membership when no exact personal name exists', () => {
		expect(
			resolveCrashCoursePppAlumniMembership({
				userEmail: 'renamed@example.com',
				purchaseOrganizationId: 'purchase-org',
				memberships: [
					{
						id: 'other-membership',
						organizationId: 'other-org',
						organizationName: 'Other',
					},
					{
						id: 'purchase-membership',
						organizationId: 'purchase-org',
						organizationName: 'Legacy personal organization',
					},
				],
			}),
		).toMatchObject({ id: 'purchase-membership' })
	})

	it('does not guess when no personal or purchase-linked membership exists', () => {
		expect(
			resolveCrashCoursePppAlumniMembership({
				userEmail: 'learner@example.com',
				purchaseOrganizationId: null,
				memberships: [
					{
						id: 'team-membership',
						organizationId: 'team-org',
						organizationName: 'A Team',
					},
				],
			}),
		).toBeNull()
	})
})

describe('Crash Course PPP alumni command approval', () => {
	it('defaults to a read-only full dry run', () => {
		expect(parseCrashCoursePppAlumniBackfillArgs([])).toEqual({
			mode: 'dry_run',
			offset: 0,
		})
	})

	it('selects zero entries when limit is zero', () => {
		const entries = buildPlan({
			purchases: [purchase()],
			entitlements: [],
		}).approvedEntries

		expect(
			selectCrashCoursePppAlumniPlanWindow(entries, {
				offset: 0,
				limit: 0,
			}),
		).toEqual([])
	})

	it('rejects conflicting apply and dry-run flags', () => {
		expect(() =>
			parseCrashCoursePppAlumniBackfillArgs(['--apply', '--dry-run']),
		).toThrow('Choose either --apply or --dry-run')
	})

	it('requires the exact token, count, and reviewed fingerprint for apply', () => {
		const args = parseCrashCoursePppAlumniBackfillArgs([
			'--apply',
			'--confirm',
			migration.migrationId,
			'--expected-count',
			String(migration.expectedApprovedCount),
			'--approved-fingerprint',
			'abc123',
		])

		expect(
			validateCrashCoursePppAlumniApplyApproval({
				args,
				actualCount: migration.expectedApprovedCount,
				actualFingerprint: 'abc123',
				blockerCount: 0,
				couponContractsValid: true,
			}),
		).toEqual({ ok: true, issues: [] })
	})

	it('fails closed on missing approval, drift, blockers, or coupon drift', () => {
		const args = parseCrashCoursePppAlumniBackfillArgs(['--apply'])
		const result = validateCrashCoursePppAlumniApplyApproval({
			args,
			actualCount: migration.expectedApprovedCount - 1,
			actualFingerprint: 'current',
			blockerCount: 1,
			couponContractsValid: false,
		})

		expect(result.ok).toBe(false)
		expect(result.issues).toEqual(
			expect.arrayContaining([
				expect.stringContaining('confirmation token'),
				expect.stringContaining('expected count'),
				expect.stringContaining('fingerprint'),
				expect.stringContaining('blocker'),
				expect.stringContaining('coupon contract'),
			]),
		)
	})
})

describe('Crash Course PPP alumni coupon contracts', () => {
	it('accepts the four active fixed $200 protected credits', () => {
		expect(
			validateCrashCoursePppAlumniCouponContracts(couponContracts()),
		).toMatchObject({ ok: true, issues: [] })
	})

	it('rejects amount, product, merchant type, and eligibility drift', () => {
		const contracts = couponContracts()
		const firstContract = contracts[0]
		if (!firstContract) throw new Error('Expected the first coupon contract')
		contracts[0] = {
			...firstContract,
			couponAmountDiscount: 10_000,
			restrictedToProductId: 'product-wrong',
			merchantCouponType: 'special',
			couponExclusive: false,
			couponStackable: true,
			couponExpiresAt: new Date('2026-08-14T00:00:00.000Z'),
			couponMaxUses: 1,
			couponUsedCount: 1,
			eligibilityCondition: {
				type: 'hasValidProductPurchase',
				productId: 'product-wrong',
			},
		}

		const result = validateCrashCoursePppAlumniCouponContracts(contracts)

		expect(result.ok).toBe(false)
		expect(result.issues).toEqual(
			expect.arrayContaining([
				expect.stringContaining('amount'),
				expect.stringContaining('restricted product'),
				expect.stringContaining('merchant type'),
				expect.stringContaining('exclusive'),
				expect.stringContaining('stackable'),
				expect.stringContaining('expired'),
				expect.stringContaining('usage limit'),
				expect.stringContaining('eligibility product'),
			]),
		)
	})
})
