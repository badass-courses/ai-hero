import { UserSchema, type defineRulesForPurchases } from '@/ability'
import { LessonSchema } from '@/lib/lessons'
import { WorkshopSchema } from '@/lib/workshops'
import { ContentResourceSchema } from '@coursebuilder/core/schemas'
import { getWorkshopResourceIds } from '@/utils/get-workshop-resource-ids'

export const entitlementTypes = [
	{ id: 'cohort-type', name: 'cohort_content_access' },
	{ id: 'workshop-type', name: 'workshop_content_access' },
]
const baseResource = {
	createdById: 'synthetic-writer',
	createdAt: null,
	updatedAt: null,
	deletedAt: null,
	organizationId: null,
	createdByOrganizationMembershipId: null,
	resourceProducts: [],
}
const edge = (resource: { id: string }, parentId: string, metadata = {}) => ({
	resourceId: resource.id,
	resourceOfId: parentId,
	position: 0,
	metadata,
	createdAt: null,
	updatedAt: null,
	deletedAt: null,
	resource,
})
export function cohortAbilityFixture(
	options: {
		contentIds?: unknown
		startsAt?: string | null
		layout?: 'direct' | 'section'
		entitlementType?: string
		roles?: string[]
		free?: boolean
	} = {},
) {
	const lesson = LessonSchema.parse({
		...baseResource,
		id: 'paid-lesson',
		type: 'lesson',
		fields: {
			title: 'Paid lesson',
			slug: 'paid-lesson',
			body: 'Protected synthetic body',
		},
		resources: [],
	})
	const section = ContentResourceSchema.parse({
		...baseResource,
		id: 'section',
		type: 'section',
		fields: { title: 'Section' },
		resources: [edge(lesson, 'section')],
	})
	const module = WorkshopSchema.parse({
		...baseResource,
		id: 'requested-workshop',
		type: 'workshop',
		fields: {
			title: 'Requested workshop',
			slug: 'requested-workshop',
			startsAt: options.startsAt,
		},
		resources: [
			edge(
				options.layout === 'section' ? section : lesson,
				'requested-workshop',
				options.free ? { tier: 'free' } : {},
			),
		],
	})
	const user = UserSchema.parse({
		id: 'synthetic-viewer',
		email: 'viewer@example.test',
		roles: (options.roles ?? []).map((name) => ({ name })),
		memberships: [
			{ id: 'membership-a', organizationId: 'organization-a' },
			{ id: 'membership-b', organizationId: 'organization-b' },
		],
		entitlements: [
			{
				type: options.entitlementType ?? 'cohort-type',
				expires: null,
				metadata: { contentIds: options.contentIds },
			},
		],
	})
	const input: Parameters<typeof defineRulesForPurchases>[0] = {
		user,
		module,
		lesson,
		entitlementTypes,
		purchases: [],
		allModuleResourceIds: getWorkshopResourceIds(module),
		...(options.layout === 'section' ? { section } : {}),
	}
	return { input, user, module, lesson, section }
}
