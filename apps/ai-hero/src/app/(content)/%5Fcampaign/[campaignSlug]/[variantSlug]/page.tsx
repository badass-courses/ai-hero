import type { ParsedUrlQuery } from 'querystring'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import {
	AI_CODING_COHORT_SLUG,
	getCampaignLanding,
	getCampaignLandingStaticParams,
} from '@/lib/campaign-landings'

import { CohortPageView } from '../../../cohorts/[slug]/page'

export const dynamic = 'force-dynamic'

/**
 * Generates the finite campaign landing route params from the source-controlled registry.
 *
 * @returns Static params with campaignSlug and variantSlug for every approved variant.
 *
 * @example
 * generateStaticParams()
 * // [{ campaignSlug: 'ai-coding', variantSlug: 'real-codebase-risk' }]
 */
export function generateStaticParams() {
	return getCampaignLandingStaticParams()
}

/**
 * Builds page metadata for an approved campaign landing variant.
 *
 * @param props - Route props containing async campaignSlug and variantSlug params.
 * @returns Metadata using variant headline and subhead, or canonical cohort metadata for unknown variants.
 *
 * @example
 * await generateMetadata({
 *   params: Promise.resolve({ campaignSlug: 'ai-coding', variantSlug: 'real-codebase-risk' }),
 * })
 */
export async function generateMetadata(props: {
	params: Promise<{ campaignSlug: string; variantSlug: string }>
}): Promise<Metadata> {
	const { campaignSlug, variantSlug } = await props.params
	const landing = getCampaignLanding(campaignSlug, variantSlug)

	if (!landing) {
		return {
			alternates: {
				canonical: `/cohorts/${AI_CODING_COHORT_SLUG}`,
			},
		}
	}

	return {
		title: landing.variant.headline,
		description: landing.variant.subhead,
		alternates: {
			canonical: `/cohorts/${landing.destination.slug}`,
		},
	}
}

/**
 * Renders an approved campaign landing variant through the shared cohort page view.
 *
 * @param props - Route props containing async params and searchParams. Search params are preserved for attribution.
 * @returns The campaign-aware cohort page, or redirects to the canonical cohort page for unknown variants.
 *
 * @example
 * <CampaignLandingPage params={params} searchParams={searchParams} />
 */
export default async function CampaignLandingPage(props: {
	params: Promise<{ campaignSlug: string; variantSlug: string }>
	searchParams: Promise<ParsedUrlQuery>
}) {
	const { campaignSlug, variantSlug } = await props.params
	const landing = getCampaignLanding(campaignSlug, variantSlug)

	if (!landing) {
		redirect(`/cohorts/${AI_CODING_COHORT_SLUG}`)
	}

	return CohortPageView({
		params: Promise.resolve({ slug: landing.destination.slug }),
		searchParams: props.searchParams,
		campaignLanding: landing,
	})
}
