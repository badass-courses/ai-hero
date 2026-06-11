import { courseBuilderAdapter, db } from '@/db'
import {
	contentResource,
	contentResourceProduct,
	contentResourceResource,
	entitlements,
	entitlementTypes,
	organizationMemberships,
	purchases,
} from '@/db/schema'
import {
	createCohortEntitlement,
	EntitlementSourceType,
} from '@/lib/entitlements'
import { ensurePersonalOrganizationWithLearnerRole } from '@/lib/personal-organization-service'
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'

export const ARCHIVE_PRODUCT_TYPE = 'cohort-archive' as const

const DEFAULT_AVAILABLE_AFTER_DAYS = 15
const DEFAULT_ACCESS_DURATION_DAYS = 365

const archivePolicySchema = z.object({
	availableAfterDays: z.coerce.number().int().nonnegative().default(15),
	accessDurationDays: z.coerce.number().int().positive().default(365),
})

export type ArchiveProductPolicy = z.infer<typeof archivePolicySchema>

type ArchivePurchaseSnapshot = {
	archivePolicy?: Partial<ArchiveProductPolicy>
}

type ArchiveProductLike = {
	type?: string | null
	fields?: Record<string, any> | null
	id: string
}

type ArchivePurchaseLike = {
	id: string
	createdAt: Date | string
	productId: string
	organizationId?: string | null
	fields?: Record<string, any> | null
}

type ArchiveUserLike = {
	id: string
	email: string
	name?: string | null
}

type ActiveArchivePurchase = ArchivePurchaseLike & {
	status: string
	bulkCouponId?: string | null
	user: ArchiveUserLike
	product: ArchiveProductLike & {
		type: typeof ARCHIVE_PRODUCT_TYPE
	}
}

type ArchiveGrantDetail = {
	resourceId: string
	cohortId: string
	cohortTitle?: string
	workshopTitle?: string
	workshopSlug?: string
	entitlementId: string
	/** true when user had NO prior access to this resource from any non-archive source */
	isNewAccess: boolean
}

type ArchiveReconciliationResult = {
	policy: ArchiveProductPolicy
	expiresAt: string
	granted: ArchiveGrantDetail[]
	removed: Array<{ resourceId: string; entitlementId: string }>
	eligibleCohortCount: number
	targetResourceCount: number
	skipped?: string
}

export type { ArchiveReconciliationResult, ArchiveGrantDetail }

type EligibleArchiveCohort = {
	id: string
	fields?: {
		title?: string
		state?: string
		endsAt?: string
	} | null
	resources?: Array<{
		resource?: {
			id: string
			type: string
			fields?: {
				title?: string
			} | null
		} | null
	}> | null
	resourceProducts?: Array<{
		product?: {
			id: string
			type?: string | null
			fields?: {
				state?: string
			} | null
			deletedAt?: Date | null
		} | null
	}> | null
}

const addDays = (date: Date | string, days: number) => {
	const next = new Date(date)
	next.setDate(next.getDate() + days)
	return next
}

const subtractDays = (date: Date, days: number) => {
	const next = new Date(date)
	next.setDate(next.getDate() - days)
	return next
}

export function getArchiveProductPolicy(product: ArchiveProductLike) {
	if (product.type !== ARCHIVE_PRODUCT_TYPE) {
		throw new Error(`Expected ${ARCHIVE_PRODUCT_TYPE} product`)
	}

	return archivePolicySchema.parse({
		availableAfterDays:
			product.fields?.availableAfterDays ?? DEFAULT_AVAILABLE_AFTER_DAYS,
		accessDurationDays:
			product.fields?.accessDurationDays ?? DEFAULT_ACCESS_DURATION_DAYS,
	})
}

export function getArchivePolicyForPurchase(params: {
	purchase: Pick<ArchivePurchaseLike, 'fields'>
	product: ArchiveProductLike
}) {
	const purchaseSnapshot = (params.purchase.fields ??
		{}) as ArchivePurchaseSnapshot

	return archivePolicySchema.parse({
		availableAfterDays:
			purchaseSnapshot.archivePolicy?.availableAfterDays ??
			params.product.fields?.availableAfterDays ??
			DEFAULT_AVAILABLE_AFTER_DAYS,
		accessDurationDays:
			purchaseSnapshot.archivePolicy?.accessDurationDays ??
			params.product.fields?.accessDurationDays ??
			DEFAULT_ACCESS_DURATION_DAYS,
	})
}

export function computeArchivePurchaseExpiresAt(
	purchaseCreatedAt: Date | string,
	accessDurationDays: number,
) {
	return addDays(purchaseCreatedAt, accessDurationDays)
}

function isEligibleArchiveCohort(
	cohort: EligibleArchiveCohort,
	availableAfterDays: number,
	asOf: Date,
) {
	if (cohort.fields?.state !== 'published') return false
	if (!cohort.fields?.endsAt) return false

	const endsAt = new Date(cohort.fields.endsAt)
	if (Number.isNaN(endsAt.getTime())) return false

	const eligibleAfter = subtractDays(asOf, availableAfterDays)
	if (endsAt > eligibleAfter) return false

	return Boolean(
		cohort.resourceProducts?.some(({ product }) => {
			return (
				Boolean(product) &&
				product?.type === 'cohort' &&
				product.fields?.state === 'published' &&
				!product.deletedAt
			)
		}),
	)
}

export async function getEligibleArchiveCohorts(params: {
	availableAfterDays: number
	asOf?: Date
}) {
	const asOf = params.asOf ?? new Date()

	const cohorts = await db.query.contentResource.findMany({
		where: and(
			eq(contentResource.type, 'cohort'),
			isNull(contentResource.deletedAt),
		),
		with: {
			resources: {
				with: {
					resource: true,
				},
				orderBy: [asc(contentResourceResource.position)],
			},
			resourceProducts: {
				where: isNull(contentResourceProduct.deletedAt),
				with: {
					product: true,
				},
			},
		},
	})

	return cohorts.filter((cohort) =>
		isEligibleArchiveCohort(cohort, params.availableAfterDays, asOf),
	)
}

export async function persistArchivePolicySnapshot(params: {
	purchaseId: string
	policy: ArchiveProductPolicy
}) {
	const purchase = await db.query.purchases.findFirst({
		where: eq(purchases.id, params.purchaseId),
	})

	if (!purchase) {
		throw new Error(`Purchase not found: ${params.purchaseId}`)
	}

	const nextFields = {
		...(purchase.fields ?? {}),
		archivePolicy: params.policy,
	}

	await db
		.update(purchases)
		.set({
			fields: nextFields,
		})
		.where(eq(purchases.id, params.purchaseId))

	return nextFields
}

export async function ensureArchiveEntitlementContext(params: {
	purchase: Pick<ArchivePurchaseLike, 'organizationId'>
	user: ArchiveUserLike
}) {
	if (params.purchase.organizationId) {
		const existingMembership = await db.query.organizationMemberships.findFirst(
			{
				where: and(
					eq(
						organizationMemberships.organizationId,
						params.purchase.organizationId,
					),
					eq(organizationMemberships.userId, params.user.id),
				),
			},
		)

		if (existingMembership) {
			return {
				organizationId: params.purchase.organizationId,
				orgMembership: existingMembership,
			}
		}

		const orgMembership = await courseBuilderAdapter.addMemberToOrganization({
			organizationId: params.purchase.organizationId,
			userId: params.user.id,
			invitedById: params.user.id,
		})

		if (!orgMembership) {
			throw new Error('Could not create archive organization membership')
		}

		await courseBuilderAdapter.addRoleForMember({
			organizationId: params.purchase.organizationId,
			memberId: orgMembership.id,
			role: 'learner',
		})

		return {
			organizationId: params.purchase.organizationId,
			orgMembership,
		}
	}

	const personalOrgResult = await ensurePersonalOrganizationWithLearnerRole(
		params.user,
		courseBuilderAdapter,
	)

	return {
		organizationId: personalOrgResult.organization.id,
		orgMembership: personalOrgResult.membership,
	}
}

async function getCohortContentAccessEntitlementTypeId() {
	const cohortContentAccessEntitlementType =
		await db.query.entitlementTypes.findFirst({
			where: eq(entitlementTypes.name, 'cohort_content_access'),
		})

	if (!cohortContentAccessEntitlementType) {
		throw new Error('cohort_content_access entitlement type not found')
	}

	return cohortContentAccessEntitlementType.id
}

async function getExistingArchiveEntitlementsForPurchase(purchaseId: string) {
	return await db.query.entitlements.findMany({
		where: and(
			eq(entitlements.sourceType, EntitlementSourceType.PURCHASE),
			eq(entitlements.sourceId, purchaseId),
			isNull(entitlements.deletedAt),
		),
	})
}

/**
 * Get the set of resource IDs the user already has active cohort_content_access
 * for from non-archive sources (direct cohort purchase, subscription, manual, etc.).
 * Used to determine which archive grants represent genuinely new access.
 */
async function getExistingNonArchiveAccessResourceIds(
	userId: string,
	cohortContentAccessEntitlementTypeId: string,
): Promise<Set<string>> {
	const existingEntitlements = await db.query.entitlements.findMany({
		where: and(
			eq(entitlements.userId, userId),
			eq(entitlements.entitlementType, cohortContentAccessEntitlementTypeId),
			isNull(entitlements.deletedAt),
			// Only non-expired or no-expiry entitlements
			or(
				isNull(entitlements.expiresAt),
				gt(entitlements.expiresAt, sql`CURRENT_TIMESTAMP`),
			),
		),
	})

	const resourceIds = new Set<string>()
	for (const ent of existingEntitlements) {
		// Skip archive-sourced entitlements
		if (ent.metadata?.archiveSource === ARCHIVE_PRODUCT_TYPE) continue
		const contentIds = ent.metadata?.contentIds
		if (Array.isArray(contentIds)) {
			for (const id of contentIds) {
				if (typeof id === 'string') resourceIds.add(id)
			}
		}
	}
	return resourceIds
}

export async function reconcileArchivePurchaseEntitlements(params: {
	purchase: ArchivePurchaseLike
	product: ArchiveProductLike
	user: ArchiveUserLike
	organizationId: string
	organizationMembershipId: string
	asOf?: Date
}): Promise<ArchiveReconciliationResult> {
	if (params.product.type !== ARCHIVE_PRODUCT_TYPE) {
		throw new Error(`Expected ${ARCHIVE_PRODUCT_TYPE} product`)
	}

	const asOf = params.asOf ?? new Date()
	const policy = getArchivePolicyForPurchase({
		purchase: params.purchase,
		product: params.product,
	})
	const expiresAt = computeArchivePurchaseExpiresAt(
		params.purchase.createdAt,
		policy.accessDurationDays,
	)

	if (expiresAt <= asOf) {
		return {
			policy,
			expiresAt: expiresAt.toISOString(),
			granted: [],
			removed: [],
			eligibleCohortCount: 0,
			targetResourceCount: 0,
			skipped: 'purchase access window expired',
		}
	}

	const [
		cohortContentAccessEntitlementTypeId,
		eligibleCohorts,
		existingEntitlements,
	] = await Promise.all([
		getCohortContentAccessEntitlementTypeId(),
		getEligibleArchiveCohorts({
			availableAfterDays: policy.availableAfterDays,
			asOf,
		}),
		getExistingArchiveEntitlementsForPurchase(params.purchase.id),
	])

	// Check what the user already has access to from non-archive sources
	const existingNonArchiveAccess = await getExistingNonArchiveAccessResourceIds(
		params.user.id,
		cohortContentAccessEntitlementTypeId,
	)

	const targetResources = eligibleCohorts.flatMap((cohort) => {
		return (cohort.resources ?? [])
			.map((resourceItem) => {
				const resource = resourceItem.resource
				if (!resource || resource.type !== 'workshop') return null

				return {
					resourceId: resource.id,
					cohortId: cohort.id,
					cohortTitle: cohort.fields?.title,
					cohortEndsAt: cohort.fields?.endsAt,
					workshopTitle: resource.fields?.title,
					workshopSlug: resource.fields?.slug,
				}
			})
			.filter((resource): resource is NonNullable<typeof resource> =>
				Boolean(resource),
			)
	})

	const targetResourceIds = new Set(
		targetResources.map((resource) => resource.resourceId),
	)
	const existingByResourceId = new Map(
		existingEntitlements.flatMap((entitlement) => {
			const contentIds = entitlement.metadata?.contentIds
			if (!Array.isArray(contentIds) || contentIds.length === 0) return []
			const resourceId = contentIds[0]
			return resourceId ? [[resourceId, entitlement] as const] : []
		}),
	)

	const granted: ArchiveGrantDetail[] = []
	const removed: Array<{ resourceId: string; entitlementId: string }> = []

	for (const resource of targetResources) {
		if (existingByResourceId.has(resource.resourceId)) continue

		const isNewAccess = !existingNonArchiveAccess.has(resource.resourceId)

		const entitlementId = await createCohortEntitlement({
			userId: params.user.id,
			resourceId: resource.resourceId,
			organizationId: params.organizationId,
			organizationMembershipId: params.organizationMembershipId,
			entitlementType: cohortContentAccessEntitlementTypeId,
			sourceId: params.purchase.id,
			sourceType: EntitlementSourceType.PURCHASE,
			expiresAt,
			metadata: {
				archiveSource: ARCHIVE_PRODUCT_TYPE,
				archiveProductId: params.product.id,
				archivePurchaseId: params.purchase.id,
				archiveCohortId: resource.cohortId,
				archiveCohortTitle: resource.cohortTitle,
				archiveEligibilityEndsAt: resource.cohortEndsAt,
				availableAfterDays: policy.availableAfterDays,
				accessDurationDays: policy.accessDurationDays,
				archivePolicy: policy,
				archiveAccessExpiresAt: expiresAt.toISOString(),
				archiveGrantedAt: asOf.toISOString(),
				hadPriorAccess: !isNewAccess,
			},
		})

		granted.push({
			resourceId: resource.resourceId,
			cohortId: resource.cohortId,
			cohortTitle: resource.cohortTitle,
			workshopTitle: resource.workshopTitle,
			workshopSlug: resource.workshopSlug,
			entitlementId,
			isNewAccess,
		})
	}

	for (const [resourceId, entitlement] of existingByResourceId.entries()) {
		if (targetResourceIds.has(resourceId)) continue

		await db
			.update(entitlements)
			.set({
				deletedAt: asOf,
			})
			.where(eq(entitlements.id, entitlement.id))

		removed.push({
			resourceId,
			entitlementId: entitlement.id,
		})
	}

	if (existingEntitlements.length > 0) {
		await db
			.update(entitlements)
			.set({
				expiresAt,
			})
			.where(
				and(
					eq(entitlements.sourceType, EntitlementSourceType.PURCHASE),
					eq(entitlements.sourceId, params.purchase.id),
					isNull(entitlements.deletedAt),
				),
			)
	}

	return {
		policy,
		expiresAt: expiresAt.toISOString(),
		granted,
		removed,
		eligibleCohortCount: eligibleCohorts.length,
		targetResourceCount: targetResources.length,
	}
}

export async function getActiveArchivePurchases(
	asOf = new Date(),
): Promise<ActiveArchivePurchase[]> {
	const candidatePurchases = await db.query.purchases.findMany({
		where: and(
			inArray(purchases.status, ['Valid', 'Restricted']),
			isNull(purchases.bulkCouponId),
			sql`${purchases.userId} IS NOT NULL`,
		),
		with: {
			product: true,
			user: true,
		},
	})

	const activePurchases: ActiveArchivePurchase[] = []

	for (const purchase of candidatePurchases) {
		if (!purchase.product || !purchase.user) continue
		if (purchase.product.type !== ARCHIVE_PRODUCT_TYPE) continue

		const policy = getArchivePolicyForPurchase({
			purchase,
			product: purchase.product,
		})

		if (
			computeArchivePurchaseExpiresAt(
				purchase.createdAt,
				policy.accessDurationDays,
			) > asOf
		) {
			activePurchases.push({
				...purchase,
				user: {
					id: purchase.user.id,
					email: purchase.user.email,
					name: purchase.user.name,
				},
				product: {
					id: purchase.product.id,
					type: ARCHIVE_PRODUCT_TYPE,
					fields: purchase.product.fields,
				},
			})
		}
	}

	return activePurchases
}

export async function getArchivePurchaseById(
	purchaseId: string,
): Promise<ActiveArchivePurchase | null> {
	const purchase = await db.query.purchases.findFirst({
		where: eq(purchases.id, purchaseId),
		with: {
			product: true,
			user: true,
		},
	})

	if (!purchase?.product || !purchase.user) {
		return null
	}

	if (purchase.product.type !== ARCHIVE_PRODUCT_TYPE) {
		return null
	}

	return {
		...purchase,
		user: {
			id: purchase.user.id,
			email: purchase.user.email,
			name: purchase.user.name,
		},
		product: {
			id: purchase.product.id,
			type: ARCHIVE_PRODUCT_TYPE,
			fields: purchase.product.fields,
		},
	}
}
