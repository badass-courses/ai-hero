// App-specific implementation for coursebuilder
import { cache } from 'react'
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

				const convertkitSubscriber = await getSubscriberFromCookie()
				const { session } = await getServerAuthSession()
				const lessonResource = lessonId ? await getCachedLesson(lessonId) : null
				const moduleResource = moduleId ? await getWorkshop(moduleId) : null

				const sectionResource =
					lessonResource &&
					moduleResource &&
					(await getResourceSection(lessonResource.id, moduleResource))

				const purchases = await courseBuilderAdapter.getPurchasesForUser(
					session?.user?.id,
				)

				const allModuleResourceIds = moduleResource
					? getWorkshopResourceIds(moduleResource)
					: []

				const entitlementTypes = await db.query.entitlementTypes.findMany()

				const activeEntitlements = session?.user?.id
					? await getAllUserEntitlements(session.user.id)
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
		const abilityRules = await getCurrentAbilityRulesCached(lessonId, moduleId)
		const workshop = await getCachedMinimalWorkshop(moduleId)
		const lesson = lessonId ? await getLesson(lessonId) : null

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
