import { unstable_cache } from 'next/cache'
import { createAppAbility, defineRulesForPurchases, type User } from '@/ability'
import { courseBuilderAdapter, db } from '@/db'
import { getCachedCohortNavigation } from '@/lib/cohort-navigation-query'
import { isWorkshopAvailable } from '@/lib/cohort-navigation'
import { getAllUserEntitlements } from '@/lib/entitlements-query'
import { getLesson } from '@/lib/lessons-query'
import { getPurchasedResources } from '@/lib/library-query'
import type { Workshop } from '@/lib/workshops'
import { getWorkshop, getWorkshopsForLesson } from '@/lib/workshops-query'
import { getResourcePath } from '@/utils/resource-paths'
import { getResourceSection } from '@/utils/get-resource-section'
import { getWorkshopResourceIds } from '@/utils/get-workshop-resource-ids'
import { subject } from '@casl/ability'

import type {
	EntitlementsPort,
	Learner,
	LessonAccess,
	OwnedCourse,
	WorkshopAccess,
	WorkshopSummary,
} from '@ai-hero/learner-agent'

import { getCourseResource } from './course-resources'

/** Same catalog the lesson page reads; cached apart so neither evicts the other. */
const getEntitlementTypes = unstable_cache(
	async () => db.query.entitlementTypes.findMany(),
	['learner-agent-entitlement-types'],
	{ revalidate: 300, tags: ['entitlements'] },
)

/**
 * The lesson page's ability for this learner, built from the same rule
 * function (`defineRulesForPurchases`) over the same inputs the page loads
 * in `getCurrentAbilityRules`: purchases, live entitlements (which carry
 * refunds and transfers, since those revoke them), the cohort embargo, and
 * region. One difference, on purpose: the user is passed with no roles, so
 * an admin's token reads only what that admin is entitled to.
 */
async function learnerAbility({
	learner,
	module,
	lesson,
	country,
}: {
	learner: Learner
	module: Workshop
	lesson?: Awaited<ReturnType<typeof getLesson>>
	country: string
}) {
	const [purchases, entitlements, entitlementTypes, section] =
		await Promise.all([
			courseBuilderAdapter.getPurchasesForUser(learner.userId),
			getAllUserEntitlements(learner.userId),
			getEntitlementTypes(),
			lesson ? getResourceSection(lesson.id, module) : null,
		])

	const user = {
		id: learner.userId,
		roles: [],
		entitlements: entitlements.map((entitlement) => ({
			type: entitlement.entitlementType,
			expires: entitlement.expiresAt,
			metadata: entitlement.metadata || {},
		})),
	} as unknown as User

	return createAppAbility(
		defineRulesForPurchases({
			user,
			country,
			entitlementTypes,
			isSolution: false,
			module,
			...(lesson ? { lesson } : {}),
			...(section ? { section } : {}),
			...(purchases ? { purchases } : {}),
			allModuleResourceIds: getWorkshopResourceIds(module),
		}),
	)
}

const isPublished = (module: Workshop) => module.fields?.state === 'published'

function workshopUrl(baseUrl: string, slug: string) {
	return `${baseUrl}${getResourcePath('workshop', slug)}`
}

export function makeEntitlementsPort({
	baseUrl,
	country,
}: {
	baseUrl: string
	country: string
}): EntitlementsPort {
	return {
		ownedCourses: async (learner) => {
			const purchased = await getPurchasedResources(learner.userId)
			const courses = await Promise.all(
				purchased.map(async (resource): Promise<OwnedCourse | null> => {
					if (!resource.resourceId) return null
					const course = await getCourseResource(resource.resourceId)
					if (!course) return null

					let workshops: WorkshopSummary[]
					if (course.type === 'cohort') {
						const navigation = await getCachedCohortNavigation(course.id)
						workshops = (navigation?.workshops ?? []).map((workshop) => ({
							id: workshop.id,
							slug: workshop.slug,
							title: workshop.title,
							url: workshopUrl(baseUrl, workshop.slug),
							opensAt: workshop.startsAt,
							isOpen: isWorkshopAvailable({
								state: workshop.state,
								startsAt: workshop.startsAt,
							}),
						}))
					} else {
						workshops = [
							{
								id: course.id,
								slug: course.slug,
								title: course.title,
								url: workshopUrl(baseUrl, course.slug),
								opensAt: course.startsAt,
								isOpen: isWorkshopAvailable({
									state: course.state,
									startsAt: course.startsAt,
								}),
							},
						]
					}

					const upcoming = workshops
						.filter((workshop) => !workshop.isOpen && workshop.opensAt)
						.map((workshop) => workshop.opensAt as string)
						.sort()

					return {
						id: course.id,
						slug: course.slug,
						title: course.title,
						type: course.type,
						url: `${baseUrl}${getResourcePath(course.type, course.slug)}`,
						workshops,
						nextOpensAt: upcoming[0] ?? null,
					}
				}),
			)
			return courses.filter((course): course is OwnedCourse => course !== null)
		},

		workshopAccess: async (learner, workshopId): Promise<WorkshopAccess> => {
			const module = await getWorkshop(workshopId)
			if (!module) return { _tag: 'NotEntitled' }
			const ability = await learnerAbility({ learner, module, country })

			if (!ability.can('read', subject('Content', { id: module.id }))) {
				return { _tag: 'NotEntitled' }
			}
			if (ability.can('read', 'PendingOpenAccess') || !isPublished(module)) {
				return { _tag: 'NotYetOpen', opensAt: module.fields?.startsAt ?? null }
			}
			return { _tag: 'Open' }
		},

		lessonAccess: async (learner, locator): Promise<LessonAccess> => {
			const lesson = await getLesson(locator.lesson)
			if (!lesson || lesson.type === 'solution') return { _tag: 'NotFound' }

			const workshopId =
				locator.workshop ?? (await getWorkshopsForLesson(lesson.id))[0]?.id
			const module = workshopId ? await getWorkshop(workshopId) : null
			if (!module || !getWorkshopResourceIds(module).includes(lesson.id)) {
				return { _tag: 'NotFound' }
			}

			const ability = await learnerAbility({ learner, module, lesson, country })
			const canRead = ability.can('read', subject('Content', { id: lesson.id }))

			if (canRead && isPublished(module)) return { _tag: 'Readable' }
			if (canRead || ability.can('read', 'PendingOpenAccess')) {
				return {
					_tag: 'NotYetOpen',
					workshopTitle: module.fields?.title ?? 'This workshop',
					opensAt: module.fields?.startsAt ?? null,
				}
			}
			return {
				_tag: 'NotEntitled',
				workshopUrl: module.fields?.slug
					? workshopUrl(baseUrl, module.fields.slug)
					: null,
			}
		},
	}
}
