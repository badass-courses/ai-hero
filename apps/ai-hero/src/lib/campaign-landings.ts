export const AI_CODING_COHORT_SLUG = 'ai-coding-for-real-engineers-m0k0w'

type CampaignLandingVariant = {
	readonly slug: string
	readonly eyebrow: string
	readonly headline: string
	readonly subhead: string
	readonly bullets: readonly string[]
	readonly proofTitle: string
	readonly proofBody: string
}

type CampaignLandingCampaign = {
	readonly slug: string
	readonly destination: {
		readonly kind: 'cohort'
		readonly slug: string
	}
	readonly variants: readonly CampaignLandingVariant[]
}

export type CampaignLandingDefinition = CampaignLandingCampaign
export type CampaignLanding = CampaignLandingCampaign & {
	readonly variant: CampaignLandingVariant
}

export const campaignLandingRegistry = [
	{
		slug: 'ai-coding',
		destination: {
			kind: 'cohort',
			slug: AI_CODING_COHORT_SLUG,
		},
		variants: [
			{
				slug: 'real-codebase-risk',
				eyebrow: 'AI coding for production codebases',
				headline: 'Use AI without lowering the standard of the code you ship',
				subhead:
					'AI Coding for Real Engineers helps you give agents the context, constraints, checks, and workflow they need to work safely inside a real codebase.',
				bullets: [
					'You care about code review, tests, and maintainable changes.',
					'You want AI to improve your feedback loop, not flood your repo with risky diffs.',
					'You need a workflow for production code, not a pile of prompting tricks.',
				],
				proofTitle: 'Bad AI code is expensive. The workflow matters.',
				proofBody:
					'The course is built around research, planning, implementation, review, and QA so agents stay inside the same engineering guardrails you already trust.',
			},
			{
				slug: 'claude-code-workflows',
				eyebrow: 'Claude Code workflows for real engineering',
				headline: 'Turn Claude Code into a repeatable engineering workflow',
				subhead:
					'AI coding is not just prompting. Learn how to shape tasks, feed context, review results, and repeat until the work is real.',
				bullets: [
					'You already use Claude Code and want a more reliable process.',
					'You want agents to handle focused pieces while you stay in control.',
					'You need practical patterns for PRDs, execution, review, and QA.',
				],
				proofTitle: 'Agents need workflow, not giant one-shot prompts.',
				proofBody:
					'This cohort teaches the repeatable loop behind useful Claude Code sessions: context, constraints, checks, and human judgment.',
			},
			{
				slug: 'typescript-ai-teams',
				eyebrow: 'AI coding for TypeScript teams',
				headline: 'Help your TypeScript team ship better AI-assisted code',
				subhead:
					'Give engineers a shared language for using AI with TypeScript, AI SDK, Next.js, tests, reviews, and production standards.',
				bullets: [
					'Your team writes TypeScript and wants AI help without chaos.',
					'You need engineers to share patterns instead of each inventing a private workflow.',
					'You want AI adoption grounded in fundamentals, judgment, and review.',
				],
				proofTitle: 'Engineering fundamentals are still the advantage.',
				proofBody:
					'AI Hero is for developers who care about the code they ship, with examples and workflows grounded in modern TypeScript engineering.',
			},
		],
	},
] as const satisfies readonly CampaignLandingCampaign[]

/**
 * Finds an approved campaign landing variant by campaign and variant slug.
 *
 * @param campaignSlug - Public campaign slug, for example `ai-coding`.
 * @param variantSlug - Public variant slug, for example `real-codebase-risk`.
 * @returns The campaign plus matched variant, or null when the route is not approved.
 *
 * @example
 * const landing = getCampaignLanding('ai-coding', 'real-codebase-risk')
 * // landing?.variant.headline
 */
export function getCampaignLanding(
	campaignSlug: string,
	variantSlug: string,
): CampaignLanding | null {
	const campaign = campaignLandingRegistry.find(
		(campaign) => campaign.slug === campaignSlug,
	)
	const variant = campaign?.variants.find(
		(variant) => variant.slug === variantSlug,
	)

	if (!campaign || !variant) return null

	return {
		...campaign,
		variant,
	}
}

/**
 * Converts the campaign landing registry into Next route params.
 *
 * @returns An array of campaignSlug and variantSlug param objects for static route generation.
 *
 * @example
 * getCampaignLandingStaticParams()
 * // [{ campaignSlug: 'ai-coding', variantSlug: 'real-codebase-risk' }]
 */
export function getCampaignLandingStaticParams() {
	return campaignLandingRegistry.flatMap((campaign) =>
		campaign.variants.map((variant) => ({
			campaignSlug: campaign.slug,
			variantSlug: variant.slug,
		})),
	)
}

/**
 * Resolves a campaign landing route to its canonical destination path.
 *
 * @param campaignSlug - Public campaign slug from the clean route.
 * @param variantSlug - Public variant slug from the clean route.
 * @returns The cohort destination path, falling back to the AI Coding cohort when unknown.
 *
 * @example
 * getCampaignLandingDestinationPath('ai-coding', 'real-codebase-risk')
 * // '/cohorts/ai-coding-for-real-engineers-m0k0w'
 */
export function getCampaignLandingDestinationPath(
	campaignSlug: string,
	variantSlug: string,
) {
	const landing = getCampaignLanding(campaignSlug, variantSlug)

	if (!landing) return `/cohorts/${AI_CODING_COHORT_SLUG}`

	return `/cohorts/${landing.destination.slug}`
}
