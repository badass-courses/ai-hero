import { createHash } from 'node:crypto'

export const CRASH_COURSE_PPP_ALUMNI_MIGRATION = {
	migrationId: 'crash-course-ppp-alumni-2026-08-14',
	cutoff: new Date('2026-08-14T23:31:41.000Z'),
	targetProductId: 'product-ma254',
	creditAmountCents: 20_000,
	expectedApprovedCount: 1_361,
	entitlementTypeName: 'apply_special_credit',
	sourceProductCoupons: {
		'product-3vfob': 'coupon_f5bae',
		'product-wdhub': 'coupon_a7bba',
		'product-7t9ek': 'coupon_31164',
		'product-pqkk5': 'coupon_ae167',
	},
	sourceProductRank: {
		'product-3vfob': 1,
		'product-wdhub': 2,
		'product-7t9ek': 3,
		'product-pqkk5': 4,
	},
} as const

type SourceProductId =
	keyof typeof CRASH_COURSE_PPP_ALUMNI_MIGRATION.sourceProductCoupons

export type AlumniPurchaseRecord = {
	id: string
	userId: string | null
	userExists: boolean
	userEmail: string | null
	productId: string
	status: string
	totalAmount: string
	bulkCouponId: string | null
	createdAt: Date
	organizationId: string | null
	organizationMembershipId: string | null
}

export type AlumniEntitlementRecord = {
	id: string
	userId: string | null
	sourceId: string
	entitlementType: string
	sourceType: string
	organizationId: string | null
	organizationMembershipId: string | null
	metadata: unknown
	deletedAt: Date | null
}

export type AlumniOrganizationMembershipRecord = {
	id: string
	organizationId: string | null
	organizationName: string | null
}

export type AlumniCouponContractRecord = {
	couponId: string
	sourceProductId: string
	couponStatus: number
	couponAmountDiscount: number | null
	restrictedToProductId: string | null
	merchantCouponId: string | null
	merchantCouponStatus: number | null
	merchantCouponAmountDiscount: number | null
	merchantCouponType: string | null
	couponExclusive: boolean
	couponStackable: boolean
	couponExpiresAt: Date | null
	couponMaxUses: number
	couponUsedCount: number
	eligibilityCondition: {
		type?: unknown
		productId?: unknown
	} | null
}

export type PppAlumniBlockerReason =
	| 'missing_user_id'
	| 'missing_user'
	| 'missing_email'
	| 'missing_organization'
	| 'missing_organization_membership'
	| 'deleted_migration_entitlement'
	| 'conflicting_active_entitlement'
	| 'invalid_migration_entitlement'
	| 'entitlement_id_collision'

export type PppAlumniPlanEntry = {
	userId: string
	userEmail: string | null
	sourcePurchaseId: string
	sourceProductId: SourceProductId
	targetCouponId: string
	organizationId: string | null
	organizationMembershipId: string | null
	entitlementId: string
	status: 'pending' | 'already_applied'
	blockerReasons: PppAlumniBlockerReason[]
}

export type CrashCoursePppAlumniBackfillArgs = {
	mode: 'dry_run' | 'apply'
	offset: number
	limit?: number
	confirm?: string
	expectedCount?: number
	approvedFingerprint?: string
	help?: true
}

export type PppAlumniPlan = {
	approvedEntries: PppAlumniPlanEntry[]
	fingerprint: string
	excludedPreexistingEntitlementCount: number
	blockers: Array<{
		userId: string | null
		reason: PppAlumniBlockerReason
	}>
	counts: {
		approved: number
		pending: number
		alreadyApplied: number
		blocked: number
	}
	bySourceProduct: Array<{
		productId: SourceProductId
		approved: number
		pending: number
		alreadyApplied: number
	}>
}

const migration = CRASH_COURSE_PPP_ALUMNI_MIGRATION
const sourceProductIds = Object.keys(
	migration.sourceProductCoupons,
) as SourceProductId[]
const alumniCouponIds: ReadonlySet<string> = new Set<string>(
	Object.values(migration.sourceProductCoupons),
)

const isSourceProductId = (productId: string): productId is SourceProductId =>
	sourceProductIds.includes(productId as SourceProductId)

const metadataMigrationId = (metadata: unknown): string | null => {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
		return null
	}
	const value = Reflect.get(metadata, 'migrationId')
	return typeof value === 'string' ? value : null
}

export const isCrashCoursePppAlumniMigrationMetadata = (
	metadata: unknown,
): boolean => metadataMigrationId(metadata) === migration.migrationId

const comparePurchasesNewestCohortFirst = (
	left: AlumniPurchaseRecord,
	right: AlumniPurchaseRecord,
): number => {
	const rankDifference =
		migration.sourceProductRank[right.productId as SourceProductId] -
		migration.sourceProductRank[left.productId as SourceProductId]
	if (rankDifference !== 0) return rankDifference

	const dateDifference = right.createdAt.getTime() - left.createdAt.getTime()
	if (dateDifference !== 0) return dateDifference

	return right.id.localeCompare(left.id)
}

const isBaseQualifyingPurchase = (
	purchase: AlumniPurchaseRecord,
): purchase is AlumniPurchaseRecord & { productId: SourceProductId } =>
	isSourceProductId(purchase.productId) &&
	purchase.status === 'Restricted' &&
	Number(purchase.totalAmount) > 0 &&
	purchase.bulkCouponId === null &&
	purchase.createdAt.getTime() <= migration.cutoff.getTime()

export const resolveCrashCoursePppAlumniMembership = ({
	userEmail,
	purchaseOrganizationId,
	memberships,
}: {
	userEmail: string | null
	purchaseOrganizationId: string | null
	memberships: AlumniOrganizationMembershipRecord[]
}): AlumniOrganizationMembershipRecord | null => {
	if (userEmail) {
		const expectedName = `Personal (${userEmail})`
		const personalMembership = memberships.find(
			(membership) => membership.organizationName === expectedName,
		)
		if (personalMembership) return personalMembership
	}

	if (purchaseOrganizationId) {
		return (
			memberships.find(
				(membership) => membership.organizationId === purchaseOrganizationId,
			) ?? null
		)
	}

	return null
}

const readRequiredArgument = (
	argv: string[],
	index: number,
	flag: string,
): string => {
	const value = argv[index + 1]
	if (!value || value.startsWith('--')) {
		throw new Error(`Missing value for ${flag}`)
	}
	return value
}

const parseNonNegativeInteger = (value: string, flag: string): number => {
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${flag} must be a non-negative integer`)
	}
	return parsed
}

export const parseCrashCoursePppAlumniBackfillArgs = (
	argv: string[],
): CrashCoursePppAlumniBackfillArgs => {
	const parsed: CrashCoursePppAlumniBackfillArgs = {
		mode: 'dry_run',
		offset: 0,
	}
	let selectedMode: 'dry_run' | 'apply' | undefined

	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index]
		switch (flag) {
			case '--dry-run':
				if (selectedMode && selectedMode !== 'dry_run') {
					throw new Error('Choose either --apply or --dry-run, not both')
				}
				selectedMode = 'dry_run'
				parsed.mode = 'dry_run'
				break
			case '--apply':
				if (selectedMode && selectedMode !== 'apply') {
					throw new Error('Choose either --apply or --dry-run, not both')
				}
				selectedMode = 'apply'
				parsed.mode = 'apply'
				break
			case '--confirm':
				parsed.confirm = readRequiredArgument(argv, index, flag)
				index++
				break
			case '--approved-fingerprint':
				parsed.approvedFingerprint = readRequiredArgument(argv, index, flag)
				index++
				break
			case '--expected-count':
				parsed.expectedCount = parseNonNegativeInteger(
					readRequiredArgument(argv, index, flag),
					flag,
				)
				index++
				break
			case '--limit':
				parsed.limit = parseNonNegativeInteger(
					readRequiredArgument(argv, index, flag),
					flag,
				)
				index++
				break
			case '--offset':
				parsed.offset = parseNonNegativeInteger(
					readRequiredArgument(argv, index, flag),
					flag,
				)
				index++
				break
			case '--help':
				parsed.help = true
				break
			default:
				throw new Error(`Unknown argument: ${flag}`)
		}
	}

	return parsed
}

export const validateCrashCoursePppAlumniApplyApproval = ({
	args,
	actualCount,
	actualFingerprint,
	blockerCount,
	couponContractsValid,
}: {
	args: CrashCoursePppAlumniBackfillArgs
	actualCount: number
	actualFingerprint: string
	blockerCount: number
	couponContractsValid: boolean
}): { ok: boolean; issues: string[] } => {
	if (args.mode !== 'apply') return { ok: true, issues: [] }

	const issues: string[] = []
	if (args.confirm !== migration.migrationId) {
		issues.push(`The confirmation token must equal ${migration.migrationId}`)
	}
	if (
		args.expectedCount !== migration.expectedApprovedCount ||
		actualCount !== migration.expectedApprovedCount ||
		args.expectedCount !== actualCount
	) {
		issues.push(
			`The expected count must equal the reviewed ${migration.expectedApprovedCount} users`,
		)
	}
	if (
		!args.approvedFingerprint ||
		args.approvedFingerprint !== actualFingerprint
	) {
		issues.push('The approved fingerprint does not match the current plan')
	}
	if (blockerCount > 0) {
		issues.push(`The plan has ${blockerCount} blocker records`)
	}
	if (!couponContractsValid) {
		issues.push('The coupon contract preflight failed')
	}

	return { ok: issues.length === 0, issues }
}

export const deterministicPppAlumniEntitlementId = (userId: string): string => {
	const digest = createHash('sha256')
		.update(`${migration.migrationId}:${userId}`)
		.digest('hex')
		.slice(0, 32)
	return `entitlement_ppp_alumni_${digest}`
}

export const selectCrashCoursePppAlumniPlanWindow = (
	entries: PppAlumniPlanEntry[],
	args: Pick<CrashCoursePppAlumniBackfillArgs, 'offset' | 'limit'>,
): PppAlumniPlanEntry[] => {
	const end =
		args.limit === undefined ? entries.length : args.offset + args.limit
	return entries.slice(args.offset, end)
}

export const validateCrashCoursePppAlumniAppliedWindow = (
	beforeWindow: PppAlumniPlanEntry[],
	afterEntries: PppAlumniPlanEntry[],
): { ok: boolean; failedPositions: number[] } => {
	const afterByUserId = new Map(
		afterEntries.map((entry) => [entry.userId, entry]),
	)
	const failedPositions = beforeWindow.flatMap((entry, position) => {
		const after = afterByUserId.get(entry.userId)
		return after?.status === 'already_applied' &&
			after.blockerReasons.length === 0
			? []
			: [position]
	})
	return { ok: failedPositions.length === 0, failedPositions }
}

export const buildCrashCoursePppAlumniPlan = ({
	purchases,
	entitlements,
	entitlementTypeId,
}: {
	purchases: AlumniPurchaseRecord[]
	entitlements: AlumniEntitlementRecord[]
	entitlementTypeId: string
}): PppAlumniPlan => {
	const purchasesByUser = new Map<string, AlumniPurchaseRecord[]>()
	const identityBlockers: PppAlumniPlan['blockers'] = []
	for (const purchase of purchases) {
		if (!isBaseQualifyingPurchase(purchase)) continue
		if (!purchase.userId) {
			identityBlockers.push({ userId: null, reason: 'missing_user_id' })
			continue
		}
		const existing = purchasesByUser.get(purchase.userId) ?? []
		existing.push(purchase)
		purchasesByUser.set(purchase.userId, existing)
	}

	const entitlementsByUser = new Map<string, AlumniEntitlementRecord[]>()
	for (const entitlement of entitlements) {
		if (
			!entitlement.userId ||
			(!alumniCouponIds.has(entitlement.sourceId) &&
				!isCrashCoursePppAlumniMigrationMetadata(entitlement.metadata))
		) {
			continue
		}
		const existing = entitlementsByUser.get(entitlement.userId) ?? []
		existing.push(entitlement)
		entitlementsByUser.set(entitlement.userId, existing)
	}

	const approvedEntries: PppAlumniPlanEntry[] = []
	let excludedPreexistingEntitlementCount = 0

	for (const [userId, userPurchases] of purchasesByUser) {
		const sourcePurchase = [...userPurchases].sort(
			comparePurchasesNewestCohortFirst,
		)[0]
		if (!sourcePurchase || !isSourceProductId(sourcePurchase.productId)) {
			continue
		}

		const userEntitlements = entitlementsByUser.get(userId) ?? []
		const activeEntitlements = userEntitlements.filter(
			(entitlement) => entitlement.deletedAt === null,
		)
		const activeMigrationEntitlements = activeEntitlements.filter(
			(entitlement) =>
				isCrashCoursePppAlumniMigrationMetadata(entitlement.metadata),
		)
		const activePreexistingEntitlements = activeEntitlements.filter(
			(entitlement) =>
				!isCrashCoursePppAlumniMigrationMetadata(entitlement.metadata),
		)

		if (
			activeMigrationEntitlements.length === 0 &&
			activePreexistingEntitlements.length > 0
		) {
			excludedPreexistingEntitlementCount++
			continue
		}

		const blockerReasons: PppAlumniBlockerReason[] = []
		if (!sourcePurchase.userExists) blockerReasons.push('missing_user')
		if (!sourcePurchase.userEmail) blockerReasons.push('missing_email')
		if (!sourcePurchase.organizationId) {
			blockerReasons.push('missing_organization')
		}
		if (!sourcePurchase.organizationMembershipId) {
			blockerReasons.push('missing_organization_membership')
		}
		if (
			activeMigrationEntitlements.length === 0 &&
			userEntitlements.some(
				(entitlement) =>
					entitlement.deletedAt !== null &&
					isCrashCoursePppAlumniMigrationMetadata(entitlement.metadata),
			)
		) {
			blockerReasons.push('deleted_migration_entitlement')
		}
		if (
			activeMigrationEntitlements.length > 0 &&
			activePreexistingEntitlements.length > 0
		) {
			blockerReasons.push('conflicting_active_entitlement')
		}

		const entry: PppAlumniPlanEntry = {
			userId,
			userEmail: sourcePurchase.userEmail,
			sourcePurchaseId: sourcePurchase.id,
			sourceProductId: sourcePurchase.productId,
			targetCouponId: migration.sourceProductCoupons[sourcePurchase.productId],
			organizationId: sourcePurchase.organizationId,
			organizationMembershipId: sourcePurchase.organizationMembershipId,
			entitlementId: deterministicPppAlumniEntitlementId(userId),
			status:
				activeMigrationEntitlements.length > 0 ? 'already_applied' : 'pending',
			blockerReasons,
		}

		if (
			activeMigrationEntitlements.length > 1 ||
			activeMigrationEntitlements.some(
				(entitlement) =>
					!doesMigrationEntitlementMatchEntry(
						entitlement,
						entry,
						entitlementTypeId,
					),
			)
		) {
			blockerReasons.push('invalid_migration_entitlement')
		}

		approvedEntries.push(entry)
	}

	approvedEntries.sort((left, right) => left.userId.localeCompare(right.userId))

	const entitlementIds = new Map<string, PppAlumniPlanEntry[]>()
	for (const entry of approvedEntries) {
		const matching = entitlementIds.get(entry.entitlementId) ?? []
		matching.push(entry)
		entitlementIds.set(entry.entitlementId, matching)
	}
	for (const entries of entitlementIds.values()) {
		if (entries.length <= 1) continue
		for (const entry of entries) {
			entry.blockerReasons.push('entitlement_id_collision')
		}
	}

	const blockers = [
		...identityBlockers,
		...approvedEntries.flatMap((entry) =>
			entry.blockerReasons.map((reason) => ({
				userId: entry.userId,
				reason,
			})),
		),
	]
	const fingerprintPayload = approvedEntries
		.map((entry) =>
			[
				migration.migrationId,
				entry.userId,
				entry.sourcePurchaseId,
				entry.sourceProductId,
				entry.targetCouponId,
				entry.organizationId ?? '',
				entry.organizationMembershipId ?? '',
				entry.entitlementId,
				entitlementTypeId,
				'COUPON',
				migration.targetProductId,
				String(migration.creditAmountCents),
				'official_ppp_prior_cohort_alumni',
			].join(':'),
		)
		.join('\n')
	const fingerprint = createHash('sha256')
		.update(fingerprintPayload)
		.digest('hex')

	const bySourceProduct = sourceProductIds.map((productId) => {
		const entries = approvedEntries.filter(
			(entry) => entry.sourceProductId === productId,
		)
		return {
			productId,
			approved: entries.length,
			pending: entries.filter((entry) => entry.status === 'pending').length,
			alreadyApplied: entries.filter(
				(entry) => entry.status === 'already_applied',
			).length,
		}
	})

	return {
		approvedEntries,
		fingerprint,
		excludedPreexistingEntitlementCount,
		blockers,
		counts: {
			approved: approvedEntries.length,
			pending: approvedEntries.filter((entry) => entry.status === 'pending')
				.length,
			alreadyApplied: approvedEntries.filter(
				(entry) => entry.status === 'already_applied',
			).length,
			blocked:
				approvedEntries.filter((entry) => entry.blockerReasons.length > 0)
					.length + identityBlockers.length,
		},
		bySourceProduct,
	}
}

const metadataField = (metadata: unknown, key: string): unknown => {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
		return undefined
	}
	return Reflect.get(metadata, key)
}

export const doesMigrationEntitlementMatchEntry = (
	entitlement: AlumniEntitlementRecord,
	entry: PppAlumniPlanEntry,
	entitlementTypeId: string,
): boolean =>
	entitlement.id === entry.entitlementId &&
	entitlement.userId === entry.userId &&
	entitlement.sourceId === entry.targetCouponId &&
	entitlement.entitlementType === entitlementTypeId &&
	entitlement.sourceType === 'COUPON' &&
	entitlement.organizationId === entry.organizationId &&
	entitlement.organizationMembershipId === entry.organizationMembershipId &&
	metadataField(entitlement.metadata, 'migrationId') ===
		migration.migrationId &&
	metadataField(entitlement.metadata, 'eligibilityProductId') ===
		entry.sourceProductId &&
	metadataField(entitlement.metadata, 'sourcePurchaseId') ===
		entry.sourcePurchaseId &&
	metadataField(entitlement.metadata, 'targetProductId') ===
		migration.targetProductId &&
	metadataField(entitlement.metadata, 'creditAmountCents') ===
		migration.creditAmountCents &&
	metadataField(entitlement.metadata, 'policy') ===
		'official_ppp_prior_cohort_alumni'

export const validateCrashCoursePppAlumniCouponContract = (
	record: AlumniCouponContractRecord,
	now: Date = new Date(),
): string[] => {
	const couponId = record.couponId
	const issues: string[] = []
	if (!isSourceProductId(record.sourceProductId)) {
		issues.push(`${couponId} source product is not an approved cohort`)
		return issues
	}
	if (migration.sourceProductCoupons[record.sourceProductId] !== couponId) {
		issues.push(`${couponId} source product mapping is invalid`)
	}
	if (record.couponStatus !== 1) {
		issues.push(`${couponId} coupon is not active`)
	}
	if (record.couponAmountDiscount !== migration.creditAmountCents) {
		issues.push(`${couponId} coupon amount is not $200`)
	}
	if (record.restrictedToProductId !== migration.targetProductId) {
		issues.push(`${couponId} restricted product is not the Crash Course`)
	}
	if (!record.couponExclusive) {
		issues.push(`${couponId} is not exclusive`)
	}
	if (record.couponStackable) {
		issues.push(`${couponId} is marked stackable`)
	}
	if (
		record.couponExpiresAt &&
		record.couponExpiresAt.getTime() <= now.getTime()
	) {
		issues.push(`${couponId} is expired`)
	}
	if (
		record.couponMaxUses !== -1 &&
		record.couponUsedCount >= record.couponMaxUses
	) {
		issues.push(`${couponId} reached its usage limit`)
	}
	if (!record.merchantCouponId) {
		issues.push(`${couponId} has no merchant coupon`)
	}
	if (record.merchantCouponStatus !== 1) {
		issues.push(`${couponId} merchant coupon is not active`)
	}
	if (record.merchantCouponAmountDiscount !== migration.creditAmountCents) {
		issues.push(`${couponId} merchant amount is not $200`)
	}
	if (record.merchantCouponType !== 'special credit') {
		issues.push(`${couponId} merchant type is not special credit`)
	}
	if (record.eligibilityCondition?.type !== 'hasValidProductPurchase') {
		issues.push(`${couponId} eligibility type is invalid`)
	}
	if (record.eligibilityCondition?.productId !== record.sourceProductId) {
		issues.push(`${couponId} eligibility product does not match source`)
	}
	return issues
}

export const validateCrashCoursePppAlumniCouponContracts = (
	records: AlumniCouponContractRecord[],
	now: Date = new Date(),
): { ok: boolean; issues: string[]; fingerprint: string } => {
	const recordsByCouponId = new Map(
		records.map((record) => [record.couponId, record]),
	)
	const issues: string[] = []

	for (const sourceProductId of sourceProductIds) {
		const couponId = migration.sourceProductCoupons[sourceProductId]
		const record = recordsByCouponId.get(couponId)
		if (!record) {
			issues.push(`Missing coupon contract for ${couponId}`)
			continue
		}
		issues.push(...validateCrashCoursePppAlumniCouponContract(record, now))
	}

	const unexpectedCouponIds = records
		.map((record) => record.couponId)
		.filter((couponId) => !alumniCouponIds.has(couponId))
	for (const couponId of unexpectedCouponIds) {
		issues.push(`Unexpected coupon contract ${couponId}`)
	}

	const fingerprintPayload = [...records]
		.sort((left, right) => left.couponId.localeCompare(right.couponId))
		.map((record) =>
			[
				record.couponId,
				record.sourceProductId,
				String(record.couponStatus),
				String(record.couponAmountDiscount),
				record.restrictedToProductId ?? '',
				String(record.couponExclusive),
				String(record.couponStackable),
				record.couponExpiresAt?.toISOString() ?? '',
				String(record.couponMaxUses),
				String(record.couponUsedCount),
				record.merchantCouponId ?? '',
				String(record.merchantCouponStatus),
				String(record.merchantCouponAmountDiscount),
				record.merchantCouponType ?? '',
				String(record.eligibilityCondition?.type ?? ''),
				String(record.eligibilityCondition?.productId ?? ''),
			].join(':'),
		)
		.join('\n')
	const fingerprint = createHash('sha256')
		.update(fingerprintPayload)
		.digest('hex')

	return { ok: issues.length === 0, issues, fingerprint }
}
