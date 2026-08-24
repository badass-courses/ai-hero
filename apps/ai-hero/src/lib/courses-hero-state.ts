import 'server-only'

import { checkCohortAccess, getCachedCohort } from '@/lib/cohorts-query'
import { getNextOfferSafe, type NextOffer } from '@/lib/next-offer'
import type { UpcomingCohortSummary } from '@/lib/upcoming-cohort-query'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { getCurrentOrganizationId } from '@/server/organization-context'

/**
 * The `/courses` hero has four states, and three of them are about the reader
 * rather than the product. Resolving them is the only real data work in
 * workstream C, and it belongs here rather than in the component so the hero
 * stays a rendering decision.
 *
 * | State | What the hero shows |
 * |---|---|
 * | **Waitlist** (between cohorts) | the Kit form, in the hero body |
 * | **Purchasable** | a button to the cohort page |
 * | **On sale** | the discount and its deadline — never a price |
 * | **Bought + running** | not a sales state at all: a strip at the top of the page |
 *
 * `/courses` is `force-dynamic`, so per-request auth and clock reads are fine.
 */
export type CoursesHeroState = {
	/**
	 * A live discount on THIS cohort, or null. Never carries a price: PPP makes
	 * a displayed number situation-dependent, so the claim is the saving and the
	 * deadline, both of which are true for every reader.
	 */
	sale: { formatted: string; expires: Date | null } | null
	/**
	 * Set when the viewer owns the flagship cohort AND it is inside its window
	 * right now. The hero is not a sales pitch for these readers — the page
	 * opens on a strip telling them it is on.
	 */
	running: { slug: string; title: string; endsAt: Date } | null
}

/**
 * The sale, only when the discounted resource IS this cohort.
 *
 * `getNextOfferSafe` resolves the live default coupon through
 * `getSaleBannerData`, so no coupon logic is written here. Without the id guard
 * a discount on a workshop would advertise itself on the cohort hero, which is
 * both wrong and, for anyone who clicks, a bait and switch.
 */
function resolveSale(
	offer: NextOffer | null,
	flagship: UpcomingCohortSummary | null,
): CoursesHeroState['sale'] {
	if (!offer || offer.kind !== 'sale' || !offer.discount) return null
	if (!flagship || offer.id !== flagship.id) return null
	return {
		formatted: offer.discount.formatted,
		expires: offer.discount.expires ? new Date(offer.discount.expires) : null,
	}
}

/**
 * Owned, and on right now.
 *
 * "Owned" is entitlement-based rather than a purchases-table read, because the
 * entitlement is what actually grants access — a team seat assigned to someone
 * never shows up as their purchase. `ability.can('update', 'Content')` short
 * circuits it for admins, matching `loadCohortPageData`.
 *
 * "Running" is `startsAt <= now <= endsAt`. `UpcomingCohortSummary` does not
 * carry `endsAt`, so the window comes from the full cohort — the hero already
 * reads it for the timezone, and `getCachedCohort` dedupes the fetch.
 */
async function resolveRunning(
	flagship: UpcomingCohortSummary | null,
): Promise<CoursesHeroState['running']> {
	if (!flagship) return null

	const [cohort, authResult] = await Promise.all([
		getCachedCohort(flagship.slug),
		getServerAuthSession(),
	])

	const startsAt = cohort?.fields?.startsAt
	const endsAt = cohort?.fields?.endsAt
	if (!startsAt || !endsAt) return null

	const now = Date.now()
	const start = new Date(startsAt).getTime()
	const end = new Date(endsAt).getTime()
	if (!(start <= now && now <= end)) return null

	const session = authResult?.session ?? null
	const ability = authResult?.ability ?? null
	const user = session?.user ?? null

	const window = {
		slug: flagship.slug,
		title: flagship.title,
		endsAt: new Date(endsAt),
	}

	if (ability?.can('update', 'Content')) return window
	if (!user?.id) return null

	const organizationId = await getCurrentOrganizationId()
	if (!organizationId) return null

	const access = await checkCohortAccess(organizationId, user.id, flagship.slug)
	return access ? window : null
}

/**
 * Both reader-dependent states, resolved together.
 *
 * Either one failing must leave the page selling normally rather than take the
 * page down: a missing sale is a hero without a discount line, and a missing
 * entitlement read is a buyer who sees the pitch. Both are survivable; a 500 on
 * `/courses` is not.
 */
export async function getCoursesHeroState(
	flagship: UpcomingCohortSummary | null,
): Promise<CoursesHeroState> {
	const [offer, running] = await Promise.all([
		getNextOfferSafe(),
		resolveRunning(flagship).catch(async (error) => {
			await log
				.error('courses.hero-state.running.failed', {
					error: error instanceof Error ? error.message : 'Unknown error',
				})
				.catch(() => undefined)
			return null
		}),
	])

	return { sale: resolveSale(offer, flagship), running }
}
