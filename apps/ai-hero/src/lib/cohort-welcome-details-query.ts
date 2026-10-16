import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	entitlements,
	entitlementTypes,
} from '@/db/schema'
import { and, eq, gt, isNull, or } from 'drizzle-orm'
import {
	buildCohortWelcomeDetails,
	REAL_ENGINEERS_COHORT_ID,
} from './cohort-welcome-details'
import { INCLUDED_PRODUCTS } from './included-product-policy'

/** Called inside the send step, not from the queued purchase snapshot. Read only. */
export async function getCohortWelcomeDetails(
	resourceId: string,
	userId: string,
) {
	if (resourceId !== REAL_ENGINEERS_COHORT_ID) return undefined
	const cohort = await db.query.contentResource.findFirst({
		where: and(
			eq(contentResource.id, resourceId),
			isNull(contentResource.deletedAt),
		),
		with: {
			resources: {
				where: isNull(contentResourceResource.deletedAt),
				with: { resource: true },
			},
		},
	})
	if (!cohort || cohort.type !== 'cohort')
		throw new Error('Welcome email cohort missing')
	const now = new Date()
	const details = buildCohortWelcomeDetails(cohort, now)
	const policy = INCLUDED_PRODUCTS['product-s00zs']?.find(
		({ productId }) => productId === 'product-ma254',
	)
	if (!policy) return details
	const type = await db.query.entitlementTypes.findFirst({
		where: eq(entitlementTypes.name, 'workshop_content_access'),
	})
	if (!type) return details
	const active = await db.query.entitlements.findMany({
		where: and(
			eq(entitlements.userId, userId),
			eq(entitlements.entitlementType, type.id),
			isNull(entitlements.deletedAt),
			or(isNull(entitlements.expiresAt), gt(entitlements.expiresAt, now)),
		),
	})
	if (
		!active.some((row) => row.metadata?.contentIds?.includes(policy.workshopId))
	)
		return details
	const workshop = await db.query.contentResource.findFirst({
		where: and(
			eq(contentResource.id, policy.workshopId),
			isNull(contentResource.deletedAt),
		),
	})
	if (workshop?.fields?.slug) {
		details.crashCourseUrl = `${process.env.NEXT_PUBLIC_URL}/workshops/${workshop.fields.slug}`
	}
	return details
}
