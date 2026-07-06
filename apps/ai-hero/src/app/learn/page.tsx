import type { Metadata } from 'next'
import LayoutClient from '@/components/layout-client'
import {
	CURATED_SUGGESTIONS,
	GOAL_SECTIONS,
	TOC_ITEMS,
} from '@/components/navigation/goal-sections-data'
import { HubLayout } from '@/components/navigation/hub-layout'
import {
	getCachedFeaturedWhatsNew,
	getCachedGoalSectionItems,
	type ResolvedItem,
} from '@/lib/goal-sections-query'

import {
	MapPage,
	type ResolvedGoalSection,
} from './_components/map-page'

export const metadata: Metadata = {
	title: 'Map | AI Hero',
	description:
		'A wayfinding map of everything you can learn at AI Hero — pick what you want to do with AI coding and follow the trail.',
}

/**
 * `/learn` — Amy's Map page (W3, spec §3). Server component: resolves every
 * goal-section item and the What's New row up front, then hands plain props to
 * the presentational `MapPage`. The only client fetching on the page is the
 * bot's live search (inside `MapToc` → `AskAIHeroBot`).
 */
export default async function LearnPage() {
	// One batch query for every referenced slug (no N+1), keyed by resolved slug.
	const allSlugs = GOAL_SECTIONS.flatMap((g) =>
		g.items.map((item) => item.slugOrId),
	)

	const [resolvedItems, whatsNew] = await Promise.all([
		getCachedGoalSectionItems(allSlugs),
		getCachedFeaturedWhatsNew(3),
	])

	// Zip resolved posts back into config order; apply editorial overrides;
	// silently drop any slug that didn't resolve to a published+public post.
	const goalSections: ResolvedGoalSection[] = GOAL_SECTIONS.map((section) => {
		const items = section.items
			.map((ref): ResolvedItem | null => {
				const resolved = resolvedItems.get(ref.slugOrId)
				if (!resolved) return null
				return {
					...resolved,
					title: ref.title ?? resolved.title,
					description: ref.description ?? resolved.description,
				}
			})
			.filter((item): item is ResolvedItem => item !== null)
		return { section, items }
	})

	return (
		<LayoutClient withContainer>
			<HubLayout>
				<MapPage
					goalSections={goalSections}
					whatsNew={whatsNew}
					tocItems={TOC_ITEMS}
					suggestions={CURATED_SUGGESTIONS}
					boostSlugs={allSlugs}
				/>
			</HubLayout>
		</LayoutClient>
	)
}
