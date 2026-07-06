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

export const GOAL_SECTIONS: GoalSection[] = [
	{
		id: 'set-up-your-agent',
		question: 'How do I set up my coding agent?',
		strapline:
			'Get your agent reading the right files, following the right rules, and staying inside guardrails — before you ever ask it to write a line of code.',
		items: [
			{ slugOrId: 'a-complete-guide-to-agents-md' },
			{ slugOrId: 'plan-mode-introduction' },
			{ slugOrId: 'how-to-make-codebases-ai-agents-love' },
			{ slugOrId: 'connect-claude-code-to-github' },
		],
		moreHref: '/topics/set-up-your-agent',
		moreLabel: 'More ways to set up your agent →',
	},
	{
		id: 'ship-solid-code',
		question: 'How do I ship code I can trust?',
		strapline:
			"Stop AI from quietly rotting your codebase. Put tests first, keep the slop under control, and ship changes you'd actually put your name on.",
		items: [
			{ slugOrId: 'skill-test-driven-development-claude-code' },
			{ slugOrId: 'tracer-bullets' },
			{ slugOrId: 'skills-improve-codebase-architecture' },
		],
		moreHref: '/topics/ship-solid-code',
		moreLabel: 'More ways to ship solid code →',
		skillCta: { label: 'Try my /tdd skill →', href: '/skills-tdd' },
	},
	{
		id: 'learn-how-llms-think',
		question: 'How do LLMs actually think?',
		strapline:
			"Once you understand tokens, context windows, and how a model really reads your prompt, you stop guessing and start getting the results you want.",
		items: [
			{ slugOrId: 'what-is-an-llm' },
			{ slugOrId: 'what-are-tokens' },
			{ slugOrId: 'what-is-the-context-window' },
			{ slugOrId: 'messages-system-prompts-and-reasoning-tokens' },
			{ slugOrId: 'how-to-choose-an-llm' },
		],
		moreHref: '/topics/learn-how-llms-think',
		moreLabel: 'More ways to learn how LLMs think →',
	},
	{
		id: 'build-the-right-thing',
		question: 'How do I build the right thing?',
		strapline:
			'Turn a vague idea into a sharp PRD, slice it into agent-ready issues, and prototype the risky parts first — so you build what actually matters.',
		items: [
			{ slugOrId: 'skills-to-prd' },
			{ slugOrId: 'skills-to-issues' },
			{ slugOrId: 'burn-through-your-backlog-with-my-triage-skill' },
			{ slugOrId: 'skills-prototype' },
		],
		moreHref: '/topics/build-the-right-thing',
		moreLabel: 'More ways to build the right thing →',
		skillCta: { label: 'Try my /to-prd skill →', href: '/skills-to-prd' },
	},
]

/** Flat anchor-list source for the non-sticky `MapToc` (spec §3.2). */
export const TOC_ITEMS = GOAL_SECTIONS.map((g) => ({
	id: g.id,
	label: g.question,
}))

/** Editorial empty-state prompts for the Ask AIHero bot (spec §4.1). Exactly 3. */
export const CURATED_SUGGESTIONS: string[] = [
	'How do I set up my coding agent?',
	'How do I get Claude Code to write tests first?',
	"What's the context window, and why does it matter?",
]
