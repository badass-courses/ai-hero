// App-specific implementation for coursebuilder
import { AsyncLocalStorage } from 'node:async_hooks'
import { cache } from 'react'
import { unstable_cache } from 'next/cache'
import { headers } from 'next/headers'
import { createAppAbility, defineRulesForPurchases } from '@/ability'
import { courseBuilderAdapter, db } from '@/db'
import { getAllUserEntitlements } from '@/lib/entitlements-query'
import { getCachedLesson, getLesson } from '@/lib/lesson-read-query'
import {
	getCachedMinimalWorkshop,
	getWorkshopAccessTree,
} from '@/lib/workshops-query'
import { getServerAuthSession } from '@/server/auth'
import { measureIfSlow, noTimings, type Timings } from '@/server/perf'
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

export type AbilityTimingPart =
	| 'abilityWave1'
	| 'abilityWorkshop'
	| 'abilityWave2'
	| 'abilityPurchases'
	| 'abilityEntitlements'
	| 'abilityRules'
	| 'abilityWrapperExtras'

// The caller that starts the cached work owns its sub-timings. A cache hit
// may omit them; never split or rerun a lookup to fill an optional sample.
const abilityTimings = new AsyncLocalStorage<Timings<AbilityTimingPart>>()

function startAbilityTiming(part: AbilityTimingPart) {
	try {
		const stop = abilityTimings.getStore()?.start(part)
		if (!stop) return
		return () => {
			try {
				stop()
			} catch {
				// Telemetry must not affect the access result.
			}
		}
	} catch {
		// A failed clock must not prevent the lookup from starting.
	}
}

function timeAbilityLookup<T>(part: AbilityTimingPart, lookup: () => Promise<T>) {
	const stop = startAbilityTiming(part)
	const result = lookup()
	if (stop) void result.then(stop, stop)
	return result
}

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
				//
				// No Kit subscriber lookup here: `defineRulesForPurchases` grants
				// nothing from a subscriber, and the cookie re-fetch made this the
				// busiest Kit reader on the site for a value nothing read.
				const stopWave1 = startAbilityTiming('abilityWave1')
				const [{ session }, lessonResource, moduleResource, entitlementTypes] =
					await Promise.all([
						getServerAuthSession(),
						lessonId ? getCachedLesson(lessonId) : null,
						moduleId
							? timeAbilityLookup('abilityWorkshop', () =>
									getWorkshopAccessTree(moduleId),
								)
							: null,
						getCachedEntitlementTypes(),
					])
				stopWave1?.()

				const stopWave2 = startAbilityTiming('abilityWave2')
				const userId = session?.user?.id
				const [sectionResource, purchases, activeEntitlements] =
					await Promise.all([
						lessonResource && moduleResource
							? getResourceSection(lessonResource.id, moduleResource)
							: null,
						timeAbilityLookup('abilityPurchases', () =>
							courseBuilderAdapter.getPurchasesForUser(userId),
						),
						userId
							? timeAbilityLookup('abilityEntitlements', () =>
									getAllUserEntitlements(userId),
								)
							: ([] as Awaited<ReturnType<typeof getAllUserEntitlements>>),
					])
				stopWave2?.()

				const allModuleResourceIds = moduleResource
					? getWorkshopResourceIds(moduleResource)
					: []

				const stopRules = startAbilityTiming('abilityRules')
				const rules = defineRulesForPurchases({
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
					...(lessonResource && { lesson: lessonResource }),
					...(moduleResource && { module: moduleResource }),
					...(sectionResource ? { section: sectionResource } : {}),
					...(purchases && { purchases }),
					allModuleResourceIds,
				})
				stopRules?.()
				return rules
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
		const rulesLoader = getCurrentAbilityRulesCached(lessonId, moduleId)
		const stopExtras = startAbilityTiming('abilityWrapperExtras')
		const workshopLoader = getCachedMinimalWorkshop(moduleId)
		const lessonLoader = lessonId ? getLesson(lessonId) : null
		// Observe the extras without putting a new promise on the access path.
		if (stopExtras) {
			void Promise.all([workshopLoader, lessonLoader]).then(stopExtras, stopExtras)
		}
		const [abilityRules, workshop, lesson] = await Promise.all([
			rulesLoader,
			workshopLoader,
			lessonLoader,
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
	timings: Timings<AbilityTimingPart> = noTimings,
): Promise<
	Omit<AbilityForResource, 'canView'> & {
		canViewWorkshop: boolean
		canViewLesson: boolean
		isPendingOpenAccess: boolean
	}
> {
	if (timings === noTimings) {
		return getAbilityForResourceCached(lessonId, moduleId)
	}
	return abilityTimings.run(
		timings,
		getAbilityForResourceCached,
		lessonId,
		moduleId,
	)
}

// Re-export the type for compatibility
export type { AbilityForResource }
