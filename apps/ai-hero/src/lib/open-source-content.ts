/**
 * Curated copy for the /open-source page. Static by design (per
 * `plans/navigation-redesign.md`): there is no `tool` content type, and this
 * list changes a few times a year, so a deploy per edit is the right tradeoff.
 * Star counts are NEVER stored here, they are fetched live at the page level
 * via `getRepoStarCount`.
 */
export type OpenSourceProject = {
	/** GitHub owner, also used for the star lookup. */
	repoOwner: string
	/** GitHub repo name, also used for the star lookup. */
	repoName: string
	/** Display name for the row heading. */
	name: string
	description: string
	/** Where the row's primary link goes. */
	href: string
	/** Optional on-site companion page for the same project. */
	internalHref?: string
	internalLabel?: string
	/** When true, the page renders a live star count for this repo. */
	showStars?: boolean
}

export const OPEN_SOURCE_HERO = {
	eyebrow: 'Open source',
	title: 'Built in the open',
	description:
		'The tooling behind AI Hero is public. Read it, fork it, run it today.',
} as const

export const OPEN_SOURCE_PROJECTS: OpenSourceProject[] = [
	{
		repoOwner: 'mattpocock',
		repoName: 'sandcastle',
		name: 'Sandcastle',
		// PLACEHOLDER: taken from the GitHub description. Matt owns the final
		// one-liner. Also undecided: if Sandcastle docs land on AI Hero, this row
		// points at an internal page instead of the repo.
		description:
			'Orchestrate sandboxed coding agents in TypeScript with sandcastle.run().',
		href: 'https://github.com/mattpocock/sandcastle',
	},
	{
		repoOwner: 'mattpocock',
		repoName: 'skills',
		name: 'Skills',
		description: 'Skills for Real Engineers. Straight from my .claude directory.',
		href: 'https://github.com/mattpocock/skills',
		internalHref: '/skills',
		internalLabel: 'Browse the skills',
		showStars: true,
	},
	{
		repoOwner: 'mattpocock',
		repoName: 'dictionary-of-ai-coding',
		name: 'Dictionary of AI Coding',
		description: 'AI coding jargon, explained in plain English.',
		href: 'https://github.com/mattpocock/dictionary-of-ai-coding',
		internalHref: '/ai-coding-dictionary',
		internalLabel: 'Read the dictionary',
	},
]
