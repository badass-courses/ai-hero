// App-specific implementation for coursebuilder
import { cache } from 'react'
import { unstable_cache } from 'next/cache'
import { headers } from 'next/headers'
import { createAppAbility, defineRulesForPurchases } from '@/ability'
import { courseBuilderAdapter, db } from '@/db'
import { getSubscriberFromCookie } from '@/lib/convertkit'
import { getAllUserEntitlements } from '@/lib/entitlements-query'
import { getCachedLesson, getLesson } from '@/lib/lessons-query'
import { getCachedMinimalWorkshop, getWorkshop } from '@/lib/workshops-query'
import { getServerAuthSession } from '@/server/auth'
import { measureIfSlow } from '@/server/perf'
import { subject } from '@casl/ability'

// Import type without implementation
import { type AbilityForResource } from '@coursebuilder/utils/current-ability-rules'

import { getResourceSection } from './get-resource-section'
import { getWorkshopResourceIds } from './get-workshop-resource-ids'

/**
 * The entitlement-type CATALOG (not anyone's entitlements): a tiny table that
 * changes when a new type ships, i.e. with deploys, not with traffic. It was
 * read fresh inside every ability resolution. `defineRulesForPurchases`
 * consumes only `{id, name}` from these rows, so cache serialization cannot
 * distort anything the rules read. Five minutes, not longer: a NEW type is
 * invisible to warm instances until the entry expires, and that window must
 * stay shorter than any launch it could gate.
 */
const getCachedEntitlementTypes = unstable_cache(
	async () => db.query.entitlementTypes.findMany(),
	['entitlement-types'],
	{ revalidate: 300, tags: ['entitlements'] },
)

const getCurrentAbilityRulesCached = cache(
	async (lessonId?: string, moduleId?: string, orgId?: string) => {
		return measureIfSlow({
			event: 'perf.ability.rules.slow',
			thresholdMs: 400,
			data: {
				lessonId: lessonId ?? null,
				moduleId: moduleId ?? null,
				organizationId: orgId ?? null,
			},
			operation: async () => {
				const headerStore = await headers()
				const country =
					headerStore.get('x-vercel-ip-country') ||
					process.env.DEFAULT_COUNTRY ||
					'US'

				// Two waves, not a chain. This resolution ran as eight sequential
				// awaits, and with every query fast (functions sit beside the DB)
				// the sum of the chain WAS the cost — telemetry had it at p50
				// 574 ms per request (perf.ability.rules.slow, 2026-08-03), gating
				// the per-user tRPC batch after every navigation. Wave one is the
				// lookups that depend only on the arguments; wave two is what needs
				// the session or the wave-one rows. Critical path: the workshop
				// load, not the sum.
				const [
					convertkitSubscriber,
					{ session },
					lessonResource,
					moduleResource,
					entitlementTypes,
				] = await Promise.all([
					getSubscriberFromCookie(),
					getServerAuthSession(),
					lessonId ? getCachedLesson(lessonId) : null,
					moduleId ? getWorkshop(moduleId) : null,
					getCachedEntitlementTypes(),
				])

				const [sectionResource, purchases, activeEntitlements] =
					await Promise.all([
						lessonResource && moduleResource
							? getResourceSection(lessonResource.id, moduleResource)
							: null,
						courseBuilderAdapter.getPurchasesForUser(session?.user?.id),
						session?.user?.id
							? getAllUserEntitlements(session.user.id)
							: ([] as Awaited<ReturnType<typeof getAllUserEntitlements>>),
					])

				const allModuleResourceIds = moduleResource
					? getWorkshopResourceIds(moduleResource)
					: []

				return defineRulesForPurchases({
					user: {
						...session?.user,
						id: session?.user?.id || '',
						entitlements: activeEntitlements.map((e) => ({
							type: e.entitlementType,
							expires: e.expiresAt,
							metadata: e.metadata || {},
						})),
					},
					country,
					entitlementTypes,
					isSolution: false,
					...(convertkitSubscriber && {
						subscriber: convertkitSubscriber,
					}),
					...(lessonResource && { lesson: lessonResource }),
					...(moduleResource && { module: moduleResource }),
					...(sectionResource ? { section: sectionResource } : {}),
					...(purchases && { purchases }),
					allModuleResourceIds,
				})
			},
		})
	},
)

// Provide the actual implementation directly
export async function getCurrentAbilityRules({
	lessonId,
	moduleId,
	organizationId,
}: {
	lessonId?: string
	moduleId?: string
	organizationId?: string
}) {
	return getCurrentAbilityRulesCached(lessonId, moduleId, organizationId)
}

const getAbilityForResourceCached = cache(
	async (lessonId: string | undefined, moduleId: string) => {
		// Independent of each other — same two-wave reasoning as the rules
		// resolution above.
		const [abilityRules, workshop, lesson] = await Promise.all([
			getCurrentAbilityRulesCached(lessonId, moduleId),
			getCachedMinimalWorkshop(moduleId),
			lessonId ? getLesson(lessonId) : null,
		])

		const ability = createAppAbility(abilityRules || [])

		const canViewWorkshop = workshop
			? ability.can('read', subject('Content', { id: workshop.id }))
			: false

		const canViewLesson = lesson?.id
			? ability.can('read', subject('Content', { id: lesson.id }))
			: false
		const canInviteTeam = ability.can('read', 'Team')
		const isRegionRestricted = ability.can('read', 'RegionRestriction')
		const isPendingOpenAccess = ability.can('read', 'PendingOpenAccess')
		const canCreate = ability.can('create', 'Content')

		return {
			canViewWorkshop,
			canViewLesson,
			canInviteTeam,
			isRegionRestricted,
			isPendingOpenAccess,
			canCreate,
		}
	},
)

export async function getAbilityForResource(
	lessonId: string | undefined,
	moduleId: string,
): Promise<
	Omit<AbilityForResource, 'canView'> & {
		canViewWorkshop: boolean
		canViewLesson: boolean
		isPendingOpenAccess: boolean
	}
> {
	return getAbilityForResourceCached(lessonId, moduleId)
}

// Re-export the type for compatibility
export type { AbilityForResource }
