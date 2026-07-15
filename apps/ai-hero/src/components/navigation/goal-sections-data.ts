/**
 * Goal-section static config for the `/learn` Map page (W3, spec §2).
 *
 * Pure data — NO server imports so this stays importable from client components
 * (the Ask AIHero bot builds its map-linked boost set from `GOAL_SECTIONS` at
 * module scope). Item resolution (title/description/thumbnail/video-badge) happens
 * server-side at render time by looking each `slugOrId` up as a `Resource`; this
 * config carries slugs + editorial overrides only.
 *
 * Data is REAL and ship-ready: every `slugOrId` is a published + public post from
 * Amy's Jun 23 sidebar taxonomy (curated corpus), and every `moreHref` points at
 * the live `/topics/<tag-slug>` route (M1). Goals are phrased as visitor questions;
 * straplines are benefit-focused, in Matt's voice. Matt/Amy tune copy post-hoc.
 */

export type GoalItemRef = {
	/** Slug (or id) of an existing published + public post; resolved server-side via the `Resource` reference path. */
	slugOrId: string
	/** Override title if the post's own copy doesn't fit the goal framing; optional. */
	title?: string
	/** Override description if the post's own summary doesn't fit the goal framing; optional. */
	description?: string
}

export type GoalSkillCta = {
	/** e.g. "Try my /tdd skill →" */
	label: string
	/** Flat root-URL skill slug, e.g. "/skills-tdd". */
	href: string
}

export type GoalSection = {
	/** Anchor slug + `data-goal-section` id, e.g. "set-up-your-agent". */
	id: string
	/** Heading, phrased as a visitor question. */
	question: string
	/** 1–2 sentence benefit copy under the heading. */
	strapline: string
	/** 3–5 curated posts/videos. */
	items: GoalItemRef[]
	/** "More ways to X →" target — a live `/topics/<tag-slug>` route. */
	moreHref: string
	/** "More ways to <goal> →" label. */
	moreLabel: string
	/** Only present where a natural skill match exists; manually curated, sparse. */
	skillCta?: GoalSkillCta
}

/**
 * Three sections = Matt's three audience buckets (his wireframe feedback,
 * 2026-07-14): new to coding AND AI coding · experienced coder new to AI
 * coding · experienced at both. Questions are his exact phrasings; supersedes
 * the earlier four Jun23-taxonomy goal sections.
 */
export const GOAL_SECTIONS: GoalSection[] = [
	{
		id: 'get-started',
		question: 'How do I get started?',
		strapline:
			"Never written code? Start here — what an LLM actually is, what it can do for you, and why there's never been a better time to build your own software.",
		items: [
			{ slugOrId: 'what-is-an-llm' },
			{ slugOrId: 'what-are-llms-used-for' },
			{ slugOrId: 'what-is-an-agent' },
			{ slugOrId: 'personal-software-is-insane-in-the-age-of-ai-u2hx2' },
		],
		moreHref: '/topics/learn-how-llms-think',
		moreLabel: 'More fundamentals →',
	},
	{
		id: 'write-code-like-me',
		question: 'How can I get AI to write code like me?',
		strapline:
			'You can already code — now get the agent coding to your standard. Set up the rules, the context, and the workflow so its output reads like yours.',
		items: [
			{ slugOrId: 'the-ai-engineer-mindset' },
			{ slugOrId: 'a-complete-guide-to-agents-md' },
			{ slugOrId: 'how-to-make-codebases-ai-agents-love' },
			{ slugOrId: 'plan-mode-introduction' },
		],
		moreHref: '/topics/set-up-your-agent',
		moreLabel: 'More ways to set up your agent →',
		skillCta: {
			label: 'Install my whole setup with /setup-matt-pocock-skills →',
			href: '/skills-setup-matt-pocock-skills',
		},
	},
	{
		id: 'get-the-most-out',
		question: 'How can I get the most out of AI coding?',
		strapline:
			'Already fluent with a coding agent? Sharpen the loop — grill your plans, fire tracer bullets, keep the context lean, and keep the architecture clean.',
		items: [
			{ slugOrId: '5-agent-skills-i-use-every-day' },
			{ slugOrId: 'real-world-feature-build-with-claude-code' },
			{ slugOrId: 'tracer-bullets' },
			{ slugOrId: 'how-to-kill-the-bloat-in-claude-codes-system-prompt' },
			{ slugOrId: 'getting-started-with-ralph' },
		],
		moreHref: '/topics/get-better-results',
		moreLabel: 'More ways to get better results →',
		skillCta: { label: 'Try my /grill-me skill →', href: '/skills-grill-me' },
	},
]

/** Flat anchor-list source for the non-sticky `MapToc` (spec §3.2). */
export const TOC_ITEMS = GOAL_SECTIONS.map((g) => ({
	id: g.id,
	label: g.question,
}))

/** Editorial empty-state prompts for the Ask AIHero bot (spec §4.1). Exactly 3 — aligned with the audience buckets. */
export const CURATED_SUGGESTIONS: string[] = [
	'How do I get started with AI coding?',
	'How can I get AI to write code like me?',
	'How do I get Claude Code to write tests first?',
]
