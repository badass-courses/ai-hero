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

export type DeclaredCtaKind = 'course' | 'none'

export type DeclaredCtaCopy = {
	headline?: string
	subtitle?: string
}

export type ResolvedCta = {
	kind: DeclaredCtaKind
	copy: DeclaredCtaCopy
	source: 'fields.cta' | 'postType'
	recognized: boolean
	rawKind: string | null
}

type Fields = Record<string, unknown> | null | undefined

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

function optionalString(value: unknown) {
	return typeof value === 'string' && value.trim() ? value : undefined
}

function parseDeclaredCta(value: unknown): {
	kind: string | null
	copy: DeclaredCtaCopy
	isSet: boolean
} {
	if (value === undefined || value === null || value === '') {
		return { kind: null, copy: {}, isSet: false }
	}

	if (typeof value === 'string') {
		return { kind: value, copy: {}, isSet: true }
	}

	if (typeof value === 'object' && !Array.isArray(value)) {
		const declaration = value as Record<string, unknown>
		return {
			kind: optionalString(declaration.kind) ?? null,
			copy: {
				headline: optionalString(declaration.headline),
				subtitle: optionalString(declaration.subtitle),
			},
			isSet: true,
		}
	}

	return { kind: String(value), copy: {}, isSet: true }
}

/**
 * Mirrors the accepted declaration rule until the placement branch provides a
 * shared resolver: fields.cta wins, then postType=skill defaults to course.
 */
export function resolveCtaDeclaration(fields: Fields): ResolvedCta | null {
	const declaration = parseDeclaredCta(fields?.cta)
	const postType = optionalString(fields?.postType) ?? 'article'
	const fallback =
		postType === 'skill'
			? ({
					kind: 'course',
					copy: {},
					source: 'postType',
					recognized: true,
					rawKind: null,
				} satisfies ResolvedCta)
			: null

	if (!declaration.isSet) return fallback

	if (declaration.kind === 'course' || declaration.kind === 'none') {
		return {
			kind: declaration.kind,
			copy: declaration.copy,
			source: 'fields.cta',
			recognized: true,
			rawKind: declaration.kind,
		}
	}

	return fallback
		? {
				...fallback,
				recognized: false,
				rawKind: declaration.kind,
			}
		: {
				kind: 'none',
				copy: {},
				source: 'postType',
				recognized: false,
				rawKind: declaration.kind,
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
