import { NextResponse } from 'next/server'
import { getUpcomingCohort } from '@/lib/upcoming-cohort-query'
import { unstable_cache } from 'next/cache'

import {
	FEATURED_PROMO,
	type Promo,
} from '@/components/navigation/promo-config'
import { PALETTE_PROMO } from '@/components/search-palette/search-palette-config'

/**
 * GET /api/palette-promo
 *
 * Resolves the search palette's pinned promo row (wireframe 15: "usually the
 * next Real Engineers cohort date"). Resolution order:
 *   1. `FEATURED_PROMO` site-wide manual override
 *   2. The next purchasable cohort, with its live start date
 *   3. The static palette fallback
 */
const getPalettePromo = unstable_cache(
	async (): Promise<Promo | null> => {
		if (FEATURED_PROMO) return FEATURED_PROMO
		try {
			const cohort = await getUpcomingCohort()
			if (cohort) {
				const starts = cohort.startsAt
					? ` — starts ${new Intl.DateTimeFormat('en-US', {
							month: 'long',
							day: 'numeric',
						}).format(new Date(cohort.startsAt))}`
					: ''
				return {
					label: 'Cohort',
					message: `${cohort.title}${starts}`,
					href: `/cohorts/${cohort.slug}`,
				}
			}
		} catch {
			// fall through to the static fallback
		}
		return PALETTE_PROMO
	},
	['palette-promo'],
	{ revalidate: 900 },
)

export async function GET() {
	const promo = await getPalettePromo()
	return NextResponse.json(
		{ promo },
		{
			headers: {
				'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600',
			},
		},
	)
}
