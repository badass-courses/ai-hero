import type { ResolvedPostCta } from './post-cta'

export const BODY_CTA_COMPONENTS = [
	'SkillsNewsletterCta',
	'SkillsCta',
	'PromoCard',
	'SkillsCourseCta',
] as const

export type BodyCtaComponentName = (typeof BODY_CTA_COMPONENTS)[number]

export type BodyAuthoredCta = {
	component: BodyCtaComponentName
	line: number
	capturesEmailForAnonymousReader: boolean
	subscriberConditional: boolean
}

export type EmailAsk = {
	component: string
	source: 'body' | 'template'
	line?: number
}

export type TemplateCta = {
	component: string
	source: string
	capturesEmailOnPage: boolean
	rendersForCurrentRoute: boolean
}

export type AskInventory = {
	currentTemplateCtas: TemplateCta[]
	anonymousReaderEmailAsks: EmailAsk[]
	totalAnonymousReaderEmailAsks: number
	subscriberConditionalAsks: {
		component: string
		reason: string
	}[]
}

const bodyCtaPattern = new RegExp(
	`<\\s*(${BODY_CTA_COMPONENTS.join('|')})\\b`,
	'g',
)

function cleanMdxLine(
	line: string,
	state: { inCodeFence: boolean; inComment: boolean },
) {
	if (/^\s*(```|~~~)/.test(line)) {
		state.inCodeFence = !state.inCodeFence
		return ''
	}

	if (state.inCodeFence) {
		return ''
	}

	let remaining = line
	let cleaned = ''

	while (remaining.length > 0) {
		if (state.inComment) {
			const commentEnd = remaining.indexOf('*/}')
			if (commentEnd === -1) return cleaned
			state.inComment = false
			remaining = remaining.slice(commentEnd + 3)
			continue
		}

		const commentStart = remaining.indexOf('{/*')
		if (commentStart === -1) return cleaned + remaining

		cleaned += remaining.slice(0, commentStart)
		state.inComment = true
		remaining = remaining.slice(commentStart + 3)
	}

	return cleaned
}

/**
 * Finds the CTA components an editor authored in a CMS MDX body.
 *
 * The scanner skips fenced code and MDX comments. It returns component names and
 * source line numbers only. It never returns article copy.
 */
export function scanBodyAuthoredCtas(body: string): BodyAuthoredCta[] {
	const matches: BodyAuthoredCta[] = []
	const state = { inCodeFence: false, inComment: false }

	for (const [index, line] of body.split('\n').entries()) {
		const cleaned = cleanMdxLine(line, state)
		bodyCtaPattern.lastIndex = 0

		for (const match of cleaned.matchAll(bodyCtaPattern)) {
			const component = match[1] as BodyCtaComponentName
			matches.push({
				component,
				line: index + 1,
				capturesEmailForAnonymousReader:
					component === 'SkillsNewsletterCta' ||
					component === 'SkillsCourseCta',
				subscriberConditional: component === 'SkillsNewsletterCta',
			})
		}
	}

	return matches
}

/**
 * Models both the merged CTA route and the production route before placement.
 *
 * The merged route renders body CTAs, then the resolved course CTA, then the
 * mapped organic CTA. A resolved course suppresses PrimaryNewsletterCta.
 */
export function buildPostAskInventories({
	bodyAuthoredCtas,
	hasVideo,
	organicCtaKind,
	resolvedCta,
}: {
	bodyAuthoredCtas: BodyAuthoredCta[]
	hasVideo: boolean
	organicCtaKind: string | undefined
	resolvedCta: ResolvedPostCta
}): { merged: AskInventory; productionBeforeMerge: AskInventory } {
	const bodyEmailAsks: EmailAsk[] = bodyAuthoredCtas
		.filter((cta) => cta.capturesEmailForAnonymousReader)
		.map((cta) => ({
			component: cta.component,
			source: 'body',
			line: cta.line,
		}))
	const bodySubscriberConditionalAsks = bodyAuthoredCtas
		.filter((cta) => cta.subscriberConditional)
		.map((cta) => ({
			component: `${cta.component} at body line ${cta.line}`,
			reason: 'state varies with the Kit interest=skills field',
		}))
	const baseSubscriberConditionalAsks = [
		{
			component: 'PostSubscribeDialogButton',
			reason:
				'hidden before client mount, while subscriber state is pending, and for existing subscribers',
		},
		...bodySubscriberConditionalAsks,
	]

	const productionTemplateCtas: TemplateCta[] = []
	const productionEmailAsks = [...bodyEmailAsks]
	const productionSubscriberConditionalAsks = [
		...baseSubscriberConditionalAsks,
	]

	if (organicCtaKind) {
		productionTemplateCtas.push({
			component: 'OrganicOpportunityCta',
			source: `organicOpportunityCtaBySlug:${organicCtaKind}`,
			capturesEmailOnPage: false,
			rendersForCurrentRoute: true,
		})
	}

	if (!hasVideo) {
		productionTemplateCtas.push({
			component: 'PrimaryNewsletterCta',
			source: '!hasVideo route rule',
			capturesEmailOnPage: true,
			rendersForCurrentRoute: true,
		})
		productionEmailAsks.push({
			component: 'PrimaryNewsletterCta',
			source: 'template',
		})
		productionSubscriberConditionalAsks.push({
			component: 'PrimaryNewsletterCta',
			reason: 'hidden for an existing subscriber',
		})
	}

	const mergedTemplateCtas: TemplateCta[] = []
	const mergedEmailAsks = [...bodyEmailAsks]
	const mergedSubscriberConditionalAsks = [
		...baseSubscriberConditionalAsks,
	]

	if (resolvedCta.kind === 'course') {
		mergedTemplateCtas.push({
			component: 'SkillsCourseCta',
			source: `resolvePostCta:${resolvedCta.source}`,
			capturesEmailOnPage: true,
			rendersForCurrentRoute: true,
		})
		mergedEmailAsks.push({
			component: 'SkillsCourseCta',
			source: 'template',
		})
		mergedSubscriberConditionalAsks.push({
			component: 'SkillsCourseCta',
			reason: 'state varies with the Kit interest=skills field',
		})
	}

	if (organicCtaKind) {
		mergedTemplateCtas.push({
			component: 'OrganicOpportunityCta',
			source: `organicOpportunityCtaBySlug:${organicCtaKind}`,
			capturesEmailOnPage: false,
			rendersForCurrentRoute: true,
		})
	}

	if (resolvedCta.kind !== 'course' && !hasVideo) {
		mergedTemplateCtas.push({
			component: 'PrimaryNewsletterCta',
			source: '!hasVideo route rule, allowed when resolved CTA is not course',
			capturesEmailOnPage: true,
			rendersForCurrentRoute: true,
		})
		mergedEmailAsks.push({
			component: 'PrimaryNewsletterCta',
			source: 'template',
		})
		mergedSubscriberConditionalAsks.push({
			component: 'PrimaryNewsletterCta',
			reason: 'hidden for an existing subscriber',
		})
	}

	return {
		merged: {
			currentTemplateCtas: mergedTemplateCtas,
			anonymousReaderEmailAsks: mergedEmailAsks,
			totalAnonymousReaderEmailAsks: mergedEmailAsks.length,
			subscriberConditionalAsks: mergedSubscriberConditionalAsks,
		},
		productionBeforeMerge: {
			currentTemplateCtas: productionTemplateCtas,
			anonymousReaderEmailAsks: productionEmailAsks,
			totalAnonymousReaderEmailAsks: productionEmailAsks.length,
			subscriberConditionalAsks: productionSubscriberConditionalAsks,
		},
	}
}

export type TopOrganicTarget = {
	path: string
	resourceSlug?: string
	clicks: number
	route: 'post-or-list' | 'home' | 'skills-index' | 'cohort' | 'posts-index'
}

export const TOP_ORGANIC_TARGETS: TopOrganicTarget[] = [
	{
		path: '/my-grill-me-skill-has-gone-viral',
		clicks: 75_319,
		route: 'post-or-list',
	},
	{ path: '/skills-grill-me', clicks: 53_470, route: 'post-or-list' },
	{ path: '/grill-with-docs', clicks: 44_699, route: 'post-or-list' },
	{ path: '/', clicks: 37_275, route: 'home' },
	{
		path: '/5-agent-skills-i-use-every-day',
		clicks: 20_186,
		route: 'post-or-list',
	},
	{
		path: '/learn-anything-with-my-teach-skill',
		clicks: 11_317,
		route: 'post-or-list',
	},
	{
		path: '/use-the-grill-me-skill-k029d',
		clicks: 10_232,
		route: 'post-or-list',
	},
	{ path: '/skills-handoff', clicks: 9_286, route: 'post-or-list' },
	{ path: '/skills', clicks: 8_328, route: 'skills-index' },
	{
		path: '/getting-started-with-ralph',
		clicks: 7_545,
		route: 'post-or-list',
	},
	{
		path: '/cohorts/claude-code-for-real-engineers-2026-04',
		resourceSlug: 'claude-code-for-real-engineers-2026-04',
		clicks: 5_801,
		route: 'cohort',
	},
	{
		path: '/a-complete-guide-to-agents-md',
		clicks: 5_343,
		route: 'post-or-list',
	},
	{ path: '/skills-wayfinder', clicks: 4_272, route: 'post-or-list' },
	{
		path: '/creating-the-perfect-claude-code-status-line',
		clicks: 3_144,
		route: 'post-or-list',
	},
	{
		path: '/skills-to-prd',
		resourceSlug: 'skills-to-spec',
		clicks: 2_765,
		route: 'post-or-list',
	},
	{
		path: '/never-run-claude-init',
		clicks: 2_515,
		route: 'post-or-list',
	},
	{
		path: '/things-people-get-wrong-with-grill-me-and-grill-with-docs',
		clicks: 2_431,
		route: 'post-or-list',
	},
	{
		path: '/skill-test-driven-development-claude-code',
		clicks: 2_106,
		route: 'post-or-list',
	},
	{
		path: '/cohorts/ai-coding-for-real-engineers-m0k0w',
		resourceSlug: 'ai-coding-for-real-engineers-m0k0w',
		clicks: 2_027,
		route: 'cohort',
	},
	{
		path: '/write-a-prd-with-the-write-a-prd-skill-4kldl',
		clicks: 1_823,
		route: 'post-or-list',
	},
	{
		path: '/skills-changelog-ubiquitous-language-grill-with-docs',
		clicks: 1_763,
		route: 'post-or-list',
	},
	{ path: '/posts', clicks: 1_432, route: 'posts-index' },
	{
		path: '/ai-engineer-roadmap',
		clicks: 1_291,
		route: 'post-or-list',
	},
	{ path: '/skills-tdd', clicks: 1_097, route: 'post-or-list' },
	{ path: '/tracer-bullets', clicks: 1_034, route: 'post-or-list' },
]

export const ZERO_ASK_VIDEO_DEFECT_SLUGS = [
	'my-grill-me-skill-has-gone-viral',
	'grill-with-docs',
	'learn-anything-with-my-teach-skill',
	'skills-handoff',
	'never-run-claude-init',
	'things-people-get-wrong-with-grill-me-and-grill-with-docs',
] as const

export const EXPECTED_BODY_CTA_DEFECTS = [
	{
		slug: '5-agent-skills-i-use-every-day',
		component: 'SkillsNewsletterCta',
		line: 164,
	},
	{
		slug: 'getting-started-with-ralph',
		component: 'SkillsNewsletterCta',
		line: 187,
	},
	{
		slug: 'a-complete-guide-to-agents-md',
		component: 'SkillsNewsletterCta',
		line: 230,
	},
] as const
