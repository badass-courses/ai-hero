import { unstable_cache } from 'next/cache'
import { createAppAbility, defineRulesForPurchases, type User } from '@/ability'
import { courseBuilderAdapter, db } from '@/db'
import { getCachedCohortNavigation } from '@/lib/cohort-navigation-query'
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

type LearnerInputs = {
	purchases: Awaited<
		ReturnType<typeof courseBuilderAdapter.getPurchasesForUser>
	>
	entitlements: Awaited<ReturnType<typeof getAllUserEntitlements>>
	entitlementTypes: Awaited<ReturnType<typeof getEntitlementTypes>>
}

async function loadLearnerInputs(learner: Learner): Promise<LearnerInputs> {
	const [purchases, entitlements, entitlementTypes] = await Promise.all([
		courseBuilderAdapter.getPurchasesForUser(learner.userId),
		getAllUserEntitlements(learner.userId),
		getEntitlementTypes(),
	])
	return { purchases, entitlements, entitlementTypes }
}

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
	inputs,
	module,
	lesson,
	country,
}: {
	learner: Learner
	inputs: LearnerInputs
	module: Workshop
	lesson?: Awaited<ReturnType<typeof getLesson>>
	country: string
}) {
	const { purchases, entitlements, entitlementTypes } = inputs
	const section = lesson ? await getResourceSection(lesson.id, module) : null

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

/** Entitlement types that name the courses they open in `contentIds`. */
const CONTENT_ACCESS_TYPES = new Set([
	'cohort_content_access',
	'workshop_content_access',
])

/**
 * The cohorts and workshops a learner's live content-access entitlements
 * name: a bundle grants an included workshop this way without a purchase of
 * its own product.
 */
function entitledResourceIds(inputs: LearnerInputs): string[] {
	const typeIds = new Set(
		inputs.entitlementTypes
			.filter((type) => CONTENT_ACCESS_TYPES.has(type.name))
			.map((type) => type.id),
	)
	return inputs.entitlements.flatMap((entitlement) => {
		if (!typeIds.has(entitlement.entitlementType)) return []
		const contentIds = (entitlement.metadata as Record<string, unknown> | null)
			?.contentIds
		return Array.isArray(contentIds)
			? contentIds.filter((id): id is string => typeof id === 'string' && !!id)
			: []
	})
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
	// One request, one learner: load their purchases and entitlements once.
	const inputsByUser = new Map<string, Promise<LearnerInputs>>()
	const inputsFor = (learner: Learner) => {
		let inputs = inputsByUser.get(learner.userId)
		if (!inputs) {
			inputs = loadLearnerInputs(learner)
			inputsByUser.set(learner.userId, inputs)
		}
		return inputs
	}

	const workshopAccess = async (
		learner: Learner,
		workshopId: string,
	): Promise<WorkshopAccess> => {
		const module = await getWorkshop(workshopId)
		if (!module) return { _tag: 'NotEntitled' }
		const ability = await learnerAbility({
			learner,
			inputs: await inputsFor(learner),
			module,
			country,
		})

		if (!ability.can('read', subject('Content', { id: module.id }))) {
			return { _tag: 'NotEntitled' }
		}
		if (ability.can('read', 'PendingOpenAccess') || !isPublished(module)) {
			return { _tag: 'NotYetOpen', opensAt: module.fields?.startsAt ?? null }
		}
		return { _tag: 'Open' }
	}

	return {
		/**
		 * Courses from purchases and from content-access entitlements, each
		 * workshop's openness from `workshopAccess`, so early access and
		 * embargoes read the same here as on the lesson page. A workshop an
		 * owned cohort already lists is not listed again on its own, and a
		 * course with no workshop this learner can reach is dropped.
		 */
		ownedCourses: async (learner) => {
			const [purchased, inputs] = await Promise.all([
				getPurchasedResources(learner.userId),
				inputsFor(learner),
			])
			const candidateIds = [
				...new Set([
					...purchased.flatMap((resource) =>
						resource.resourceId ? [resource.resourceId] : [],
					),
					...entitledResourceIds(inputs),
				]),
			]
			const found = (
				await Promise.all(candidateIds.map((id) => getCourseResource(id)))
			).filter((course) => course !== null)
			const unique = [
				...new Map(found.map((course) => [course.id, course])).values(),
			]

			const courses = await Promise.all(
				unique.map(async (course) => {
					const listed =
						course.type === 'cohort'
							? ((await getCachedCohortNavigation(course.id))?.workshops ?? [])
							: [course]
					const workshops = await Promise.all(
						listed.map(async (workshop) => {
							const access = await workshopAccess(learner, workshop.id)
							return {
								access,
								summary: {
									id: workshop.id,
									slug: workshop.slug,
									title: workshop.title,
									url: workshopUrl(baseUrl, workshop.slug),
									opensAt:
										access._tag === 'NotYetOpen'
											? (access.opensAt ?? workshop.startsAt)
											: workshop.startsAt,
									isOpen: access._tag === 'Open',
								} satisfies WorkshopSummary,
							}
						}),
					)
					if (workshops.every(({ access }) => access._tag === 'NotEntitled')) {
						return null
					}
					const upcoming = workshops
						.filter(
							({ access, summary }) =>
								access._tag === 'NotYetOpen' && summary.opensAt,
						)
						.map(({ summary }) => summary.opensAt as string)
						.sort()

					return {
						id: course.id,
						slug: course.slug,
						title: course.title,
						type: course.type,
						url: `${baseUrl}${getResourcePath(course.type, course.slug)}`,
						workshops: workshops.map(({ summary }) => summary),
						nextOpensAt: upcoming[0] ?? null,
					} satisfies OwnedCourse
				}),
			)

			const owned = courses.filter((course) => course !== null)
			const inCohorts = new Set(
				owned
					.filter((course) => course.type === 'cohort')
					.flatMap((course) => course.workshops.map((workshop) => workshop.id)),
			)
			return owned.filter(
				(course) => course.type === 'cohort' || !inCohorts.has(course.id),
			)
		},

		workshopAccess,

		lessonAccess: async (learner, locator): Promise<LessonAccess> => {
			const lesson = await getLesson(locator.lesson)
			if (!lesson || lesson.type === 'solution') return { _tag: 'NotFound' }

			const workshopId =
				locator.workshop ?? (await getWorkshopsForLesson(lesson.id))[0]?.id
			const module = workshopId ? await getWorkshop(workshopId) : null
			if (!module || !getWorkshopResourceIds(module).includes(lesson.id)) {
				return { _tag: 'NotFound' }
			}

			const ability = await learnerAbility({
				learner,
				inputs: await inputsFor(learner),
				module,
				lesson,
				country,
			})
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
