import { Effect } from 'effect'
import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm'

import { db } from '../src/db/index'
import {
	coupon,
	entitlements,
	entitlementTypes,
	organizationMemberships,
	purchases,
	users,
} from '../src/db/schema'
import {
	CRASH_COURSE_PPP_ALUMNI_MIGRATION,
	buildCrashCoursePppAlumniPlan,
	doesMigrationEntitlementMatchEntry,
	isCrashCoursePppAlumniMigrationMetadata,
	parseCrashCoursePppAlumniBackfillArgs,
	resolveCrashCoursePppAlumniMembership,
	selectCrashCoursePppAlumniPlanWindow,
	validateCrashCoursePppAlumniAppliedWindow,
	validateCrashCoursePppAlumniApplyApproval,
	validateCrashCoursePppAlumniCouponContract,
	validateCrashCoursePppAlumniCouponContracts,
	type AlumniCouponContractRecord,
	type AlumniEntitlementRecord,
	type AlumniOrganizationMembershipRecord,
	type AlumniPurchaseRecord,
	type PppAlumniPlan,
	type PppAlumniPlanEntry,
} from '../src/lib/crash-course-ppp-alumni-backfill'
import { EntitlementSourceType } from '../src/lib/entitlements'

const migration = CRASH_COURSE_PPP_ALUMNI_MIGRATION
const sourceProductIds = Object.keys(migration.sourceProductCoupons)
const alumniCouponIds = Object.values(migration.sourceProductCoupons)

class BackfillCommandError extends Error {
	readonly _tag = 'BackfillCommandError'

	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message)
	}
}

const tryDatabase = <A>(label: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => new BackfillCommandError(label, cause),
	})

const fieldFromFields = (fields: unknown, key: string): unknown => {
	if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
		return undefined
	}
	return Reflect.get(fields, key)
}

const eligibilityConditionFromFields = (
	fields: unknown,
): AlumniCouponContractRecord['eligibilityCondition'] => {
	const condition = fieldFromFields(fields, 'eligibilityCondition')
	if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
		return null
	}
	return {
		type: Reflect.get(condition, 'type'),
		productId: Reflect.get(condition, 'productId'),
	}
}

type CouponRecordForContract = {
	id: string
	status: number
	amountDiscount: number | null
	restrictedToProductId: string | null
	merchantCouponId: string | null
	expires: Date | null
	maxUses: number
	usedCount: number
	fields: unknown
	merchantCoupon: {
		status: number
		amountDiscount: number | null
		type: string | null
	} | null
}

const couponContractFromRecord = (
	sourceProductId: string,
	record: CouponRecordForContract,
): AlumniCouponContractRecord => ({
	couponId: record.id,
	sourceProductId,
	couponStatus: record.status,
	couponAmountDiscount: record.amountDiscount,
	restrictedToProductId: record.restrictedToProductId,
	merchantCouponId: record.merchantCouponId,
	merchantCouponStatus: record.merchantCoupon?.status ?? null,
	merchantCouponAmountDiscount: record.merchantCoupon?.amountDiscount ?? null,
	merchantCouponType: record.merchantCoupon?.type ?? null,
	couponExclusive: fieldFromFields(record.fields, 'exclusive') === true,
	couponStackable: fieldFromFields(record.fields, 'stackable') === true,
	couponExpiresAt: record.expires,
	couponMaxUses: record.maxUses,
	couponUsedCount: record.usedCount,
	eligibilityCondition: eligibilityConditionFromFields(record.fields),
})

const summarizePlan = (plan: PppAlumniPlan) => {
	const blockerCounts = plan.blockers.reduce<Record<string, number>>(
		(counts, blocker) => {
			counts[blocker.reason] = (counts[blocker.reason] ?? 0) + 1
			return counts
		},
		{},
	)

	return {
		fingerprint: plan.fingerprint,
		counts: plan.counts,
		bySourceProduct: plan.bySourceProduct,
		excludedPreexistingEntitlementCount:
			plan.excludedPreexistingEntitlementCount,
		blockerCounts,
	}
}

const loadBackfillState = Effect.gen(function* () {
	const entitlementType = yield* tryDatabase(
		'Failed to load the special credit entitlement type',
		() =>
			db.query.entitlementTypes.findFirst({
				where: eq(entitlementTypes.name, migration.entitlementTypeName),
			}),
	)
	if (!entitlementType) {
		return yield* Effect.fail(
			new BackfillCommandError(
				`Entitlement type ${migration.entitlementTypeName} was not found`,
			),
		)
	}

	const purchaseRows = yield* tryDatabase(
		'Failed to load qualifying PPP purchases',
		() =>
			db.query.purchases.findMany({
				where: and(
					inArray(purchases.productId, [...sourceProductIds]),
					eq(purchases.status, 'Restricted'),
					gt(purchases.totalAmount, '0'),
					isNull(purchases.bulkCouponId),
					lte(purchases.createdAt, migration.cutoff),
				),
				with: { user: true },
				orderBy: (record, { asc }) => [
					asc(record.userId),
					asc(record.createdAt),
					asc(record.id),
				],
			}),
	)
	const purchaseUserIds = Array.from(
		new Set(
			purchaseRows
				.map((record) => record.userId)
				.filter((userId): userId is string => Boolean(userId)),
		),
	)
	const membershipRows =
		purchaseUserIds.length === 0
			? []
			: yield* tryDatabase('Failed to load organization memberships', () =>
					db.query.organizationMemberships.findMany({
						where: inArray(organizationMemberships.userId, purchaseUserIds),
						with: { organization: true },
						orderBy: (record, { asc }) => [
							asc(record.createdAt),
							asc(record.id),
						],
					}),
				)
	const expectedEntitlementRows = yield* tryDatabase(
		'Failed to load existing alumni entitlements',
		() =>
			db.query.entitlements.findMany({
				where: and(
					eq(entitlements.entitlementType, entitlementType.id),
					eq(entitlements.sourceType, EntitlementSourceType.COUPON),
					inArray(entitlements.sourceId, [...alumniCouponIds]),
				),
			}),
	)
	const migrationTaggedEntitlementRows = yield* tryDatabase(
		'Failed to load migration-tagged entitlements',
		() =>
			db.query.entitlements.findMany({
				where: sql`JSON_EXTRACT(${entitlements.metadata}, '$.migrationId') = ${migration.migrationId}`,
			}),
	)
	const entitlementRows = Array.from(
		new Map(
			[...expectedEntitlementRows, ...migrationTaggedEntitlementRows].map(
				(record) => [record.id, record],
			),
		).values(),
	)
	const couponRows = yield* tryDatabase(
		'Failed to load alumni coupon contracts',
		() =>
			db.query.coupon.findMany({
				where: inArray(coupon.id, [...alumniCouponIds]),
				with: { merchantCoupon: true },
			}),
	)

	const membershipsByUser = new Map<
		string,
		AlumniOrganizationMembershipRecord[]
	>()
	for (const membership of membershipRows) {
		const existing = membershipsByUser.get(membership.userId) ?? []
		existing.push({
			id: membership.id,
			organizationId: membership.organizationId,
			organizationName: membership.organization?.name ?? null,
		})
		membershipsByUser.set(membership.userId, existing)
	}

	const purchaseRecords: AlumniPurchaseRecord[] = purchaseRows.map((record) => {
		const resolvedMembership = resolveCrashCoursePppAlumniMembership({
			userEmail: record.user?.email ?? null,
			purchaseOrganizationId: record.organizationId,
			memberships: record.userId
				? (membershipsByUser.get(record.userId) ?? [])
				: [],
		})
		return {
			id: record.id,
			userId: record.userId,
			userExists: Boolean(record.user),
			userEmail: record.user?.email ?? null,
			productId: record.productId,
			status: record.status,
			totalAmount: String(record.totalAmount),
			bulkCouponId: record.bulkCouponId,
			createdAt: record.createdAt,
			organizationId:
				resolvedMembership?.organizationId ?? record.organizationId,
			organizationMembershipId: resolvedMembership?.id ?? null,
		}
	})
	const entitlementRecords: AlumniEntitlementRecord[] = entitlementRows.map(
		(record) => ({
			id: record.id,
			userId: record.userId,
			sourceId: record.sourceId,
			entitlementType: record.entitlementType,
			sourceType: record.sourceType,
			organizationId: record.organizationId,
			organizationMembershipId: record.organizationMembershipId,
			metadata: record.metadata,
			deletedAt: record.deletedAt,
		}),
	)
	const couponRecordsById = new Map(
		couponRows.map((record) => [record.id, record]),
	)
	const couponContracts: AlumniCouponContractRecord[] = Object.entries(
		migration.sourceProductCoupons,
	).flatMap(([sourceProductId, couponId]) => {
		const record = couponRecordsById.get(couponId)
		if (!record) return []
		return [couponContractFromRecord(sourceProductId, record)]
	})

	const plan = buildCrashCoursePppAlumniPlan({
		purchases: purchaseRecords,
		entitlements: entitlementRecords,
		entitlementTypeId: entitlementType.id,
	})
	const couponValidation =
		validateCrashCoursePppAlumniCouponContracts(couponContracts)

	return {
		entitlementTypeId: entitlementType.id,
		plan,
		couponValidation,
	}
})

type ApplyEntryResult =
	| { status: 'created' }
	| { status: 'already_applied' }
	| { status: 'blocked_drift' }

const applyEntry = (entry: PppAlumniPlanEntry, entitlementTypeId: string) =>
	tryDatabase<ApplyEntryResult>(
		'Failed to apply a PPP alumni entitlement',
		() =>
			db.transaction(async (transaction) => {
				if (!entry.organizationId || !entry.organizationMembershipId) {
					return { status: 'blocked_drift' }
				}

				const sourcePurchase = await transaction.query.purchases.findFirst({
					where: eq(purchases.id, entry.sourcePurchaseId),
				})
				if (
					!sourcePurchase ||
					sourcePurchase.userId !== entry.userId ||
					sourcePurchase.productId !== entry.sourceProductId ||
					sourcePurchase.status !== 'Restricted' ||
					Number(sourcePurchase.totalAmount) <= 0 ||
					sourcePurchase.bulkCouponId !== null ||
					sourcePurchase.createdAt.getTime() > migration.cutoff.getTime()
				) {
					return { status: 'blocked_drift' }
				}

				const user = await transaction.query.users.findFirst({
					where: eq(users.id, entry.userId),
				})
				if (!user?.email) return { status: 'blocked_drift' }

				const membership =
					await transaction.query.organizationMemberships.findFirst({
						where: and(
							eq(organizationMemberships.id, entry.organizationMembershipId),
							eq(organizationMemberships.userId, entry.userId),
							eq(organizationMemberships.organizationId, entry.organizationId),
						),
					})
				if (!membership) return { status: 'blocked_drift' }

				const couponRecord = await transaction.query.coupon.findFirst({
					where: eq(coupon.id, entry.targetCouponId),
					with: { merchantCoupon: true },
				})
				if (!couponRecord) return { status: 'blocked_drift' }
				const liveCouponIssues = validateCrashCoursePppAlumniCouponContract(
					couponContractFromRecord(entry.sourceProductId, couponRecord),
				)
				if (liveCouponIssues.length > 0) {
					return { status: 'blocked_drift' }
				}

				const expectedExisting =
					await transaction.query.entitlements.findMany({
						where: and(
							eq(entitlements.userId, entry.userId),
							eq(entitlements.entitlementType, entitlementTypeId),
							eq(entitlements.sourceType, EntitlementSourceType.COUPON),
							inArray(entitlements.sourceId, [...alumniCouponIds]),
							isNull(entitlements.deletedAt),
						),
					})
				const migrationTagged =
					await transaction.query.entitlements.findMany({
						where: and(
							eq(entitlements.userId, entry.userId),
							isNull(entitlements.deletedAt),
							sql`JSON_EXTRACT(${entitlements.metadata}, '$.migrationId') = ${migration.migrationId}`,
						),
					})
				const existing = Array.from(
					new Map(
						[...expectedExisting, ...migrationTagged].map((record) => [
							record.id,
							record,
						]),
					).values(),
				)
				const migrationEntitlements = existing.filter((record) =>
					isCrashCoursePppAlumniMigrationMetadata(record.metadata),
				)
				const preexistingEntitlements = existing.filter(
					(record) => !isCrashCoursePppAlumniMigrationMetadata(record.metadata),
				)

				const migrationEntitlement = migrationEntitlements[0]
				if (
					migrationEntitlements.length === 1 &&
					migrationEntitlement &&
					preexistingEntitlements.length === 0 &&
					doesMigrationEntitlementMatchEntry(
						migrationEntitlement,
						entry,
						entitlementTypeId,
					)
				) {
					return { status: 'already_applied' }
				}
				if (existing.length > 0) return { status: 'blocked_drift' }

				await transaction.insert(entitlements).values({
					id: entry.entitlementId,
					userId: entry.userId,
					organizationId: entry.organizationId,
					organizationMembershipId: entry.organizationMembershipId,
					entitlementType: entitlementTypeId,
					sourceType: EntitlementSourceType.COUPON,
					sourceId: entry.targetCouponId,
					metadata: {
						migrationId: migration.migrationId,
						eligibilityProductId: entry.sourceProductId,
						sourcePurchaseId: entry.sourcePurchaseId,
						targetProductId: migration.targetProductId,
						creditAmountCents: migration.creditAmountCents,
						policy: 'official_ppp_prior_cohort_alumni',
					},
				})

				return { status: 'created' }
			}),
	)

const printUsage = () => {
	console.log(`Usage:
  pnpm crash-course:backfill-ppp-alumni --dry-run [--limit N] [--offset N]
  pnpm crash-course:backfill-ppp-alumni --apply \\
    --confirm ${migration.migrationId} \\
    --expected-count ${migration.expectedApprovedCount} \\
    --approved-fingerprint <reviewed-sha256> \\
    [--limit N] [--offset N]

Dry-run is the default. Apply writes only fixed $200 alumni entitlements. It never creates coupons, Stripe objects, purchases, organizations, or memberships.`)
}

const parseArgsOrExit = () => {
	try {
		return parseCrashCoursePppAlumniBackfillArgs(process.argv.slice(2))
	} catch (error) {
		console.error(
			JSON.stringify(
				{
					schema: 'aih.crash-course-ppp-alumni-backfill.v1',
					ok: false,
					mode: 'argument_error',
					error: error instanceof Error ? error.message : String(error),
					writesMayHaveOccurred: false,
				},
				null,
				2,
			),
		)
		process.exit(2)
	}
}

const args = parseArgsOrExit()
let writesStarted = false
const executionReceipt = {
	planFingerprint: null as string | null,
	offset: args.offset,
	limit: args.limit ?? null,
	planned: 0,
	attempted: 0,
	currentPosition: null as number | null,
	created: 0,
	alreadyApplied: 0,
	blockedDrift: 0,
}

if (args.help) {
	printUsage()
	process.exit(0)
}

const program = Effect.gen(function* () {
	const before = yield* loadBackfillState
	const window = selectCrashCoursePppAlumniPlanWindow(
		before.plan.approvedEntries,
		args,
	)
	executionReceipt.planFingerprint = before.plan.fingerprint
	executionReceipt.planned = window.length
	const approval = validateCrashCoursePppAlumniApplyApproval({
		args,
		actualCount: before.plan.counts.approved,
		actualFingerprint: before.plan.fingerprint,
		blockerCount: before.plan.counts.blocked,
		couponContractsValid: before.couponValidation.ok,
	})

	if (!approval.ok) {
		return yield* Effect.fail(
			new BackfillCommandError(
				`Apply preflight refused: ${approval.issues.join('; ')}`,
			),
		)
	}

	if (args.mode === 'apply') {
		writesStarted = window.length > 0
		for (let index = 0; index < window.length; index++) {
			const entry = window[index]
			if (!entry) continue
			executionReceipt.currentPosition = args.offset + index
			const result = yield* applyEntry(entry, before.entitlementTypeId)
			executionReceipt.attempted++
			if (result.status === 'created') executionReceipt.created++
			if (result.status === 'already_applied') {
				executionReceipt.alreadyApplied++
			}
			if (result.status === 'blocked_drift') {
				executionReceipt.blockedDrift++
				return yield* Effect.fail(
					new BackfillCommandError(
						'Apply stopped because entitlement state drifted after preflight',
					),
				)
			}
		}
		executionReceipt.currentPosition = null
	}

	const after = args.mode === 'apply' ? yield* loadBackfillState : before
	const appliedWindowValidation =
		args.mode === 'apply'
			? validateCrashCoursePppAlumniAppliedWindow(
					window,
					after.plan.approvedEntries,
				)
			: { ok: true, failedPositions: [] }
	if (
		args.mode === 'apply' &&
		(!appliedWindowValidation.ok ||
			after.plan.fingerprint !== before.plan.fingerprint ||
			after.plan.counts.approved !== migration.expectedApprovedCount ||
			after.plan.counts.blocked > 0 ||
			!after.couponValidation.ok ||
			after.couponValidation.fingerprint !==
				before.couponValidation.fingerprint)
	) {
		return yield* Effect.fail(
			new BackfillCommandError(
				'Post-apply readback detected plan or coupon contract drift',
			),
		)
	}

	return {
		schema: 'aih.crash-course-ppp-alumni-backfill.v1',
		ok: true,
		mode: args.mode,
		migration: {
			id: migration.migrationId,
			cutoff: migration.cutoff.toISOString(),
			targetProductId: migration.targetProductId,
			creditAmountCents: migration.creditAmountCents,
			expectedApprovedCount: migration.expectedApprovedCount,
		},
		couponContracts: {
			before: before.couponValidation,
			after: after.couponValidation,
		},
		before: summarizePlan(before.plan),
		window: {
			offset: args.offset,
			limit: args.limit ?? null,
			count: window.length,
		},
		execution: executionReceipt,
		appliedWindowValidation,
		after: summarizePlan(after.plan),
		writesPerformed: args.mode === 'apply' ? executionReceipt.created : 0,
	}
})

Effect.runPromise(program)
	.then((result) => {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => {
			process.exit(0)
		})
	})
	.catch((error) => {
		const failure = {
			schema: 'aih.crash-course-ppp-alumni-backfill.v1',
			ok: false,
			mode: args.mode,
			error: error instanceof Error ? error.message : String(error),
			writesMayHaveOccurred: writesStarted,
			execution: executionReceipt,
		}
		process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`, () => {
			process.exit(1)
		})
	})
