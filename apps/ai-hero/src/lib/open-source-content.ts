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
	/** Companion destinations for the same project: an on-site page, a
	 *  standalone site, whatever else the project lives on. */
	links?: { label: string; href: string }[]
	/** When true, the page renders a live star count for this repo. */
	showStars?: boolean
	/**
	 * Wordmark from the project's own README, so the page matches what people
	 * see on GitHub. Light/dark pair because every surface has to work in both
	 * themes (DESIGN.md rule 8); the README's `prefers-color-scheme` swap is
	 * redone with `dark:` variants, since theme here is class-driven and does
	 * not follow the OS.
	 */
	logo?: { light: string; dark: string }
	/**
	 * Where the wordmark points, when that is not `href`. Whatever it points to
	 * must ALSO appear in `links`: the logo link is hidden from assistive tech
	 * (it would otherwise read as an unnamed duplicate), so `links` is the only
	 * keyboard-reachable route to it.
	 */
	logoHref?: string
}

/** All project artwork lives on the shared Total TypeScript Cloudinary. */
const CLOUDINARY = 'https://res.cloudinary.com/total-typescript/image/upload'

export const OPEN_SOURCE_HERO = {
	eyebrow: 'Open source',
	title: 'Built in the open',
	description:
		'The tools I build for my own work, published as I go. Skills I run every day, a sandbox orchestrator, and a dictionary for the jargon.',
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
		logo: {
			light: `${CLOUDINARY}/v1775033787/readme-sandcastle-onlight_2x.png`,
			dark: `${CLOUDINARY}/v1775033787/readme-sandcastle-ondark_2x.png`,
		},
	},
	{
		repoOwner: 'mattpocock',
		repoName: 'skills',
		name: 'Skills',
		description: 'Skills for Real Engineers. Straight from my .claude directory.',
		href: 'https://github.com/mattpocock/skills',
		links: [{ label: 'Browse the skills', href: '/skills' }],
		showStars: true,
		// Note the asset names differ: "skill-repo-light" vs "skills-repo-dark".
		logo: {
			light: `${CLOUDINARY}/v1777382277/skill-repo-light_2x.png`,
			dark: `${CLOUDINARY}/v1777382277/skills-repo-dark_2x.png`,
		},
	},
	{
		repoOwner: 'mattpocock',
		repoName: 'dictionary-of-ai-coding',
		name: 'Dictionary of AI Coding',
		description: 'AI coding jargon, explained in plain English.',
		href: 'https://github.com/mattpocock/dictionary-of-ai-coding',
		// The wordmark IS the standalone site's brand, and the repo README links
		// it the same way, so the logo goes there rather than to GitHub.
		logoHref: 'https://aicodingdictionary.com',
		links: [
			{ label: 'Read the dictionary', href: '/ai-coding-dictionary' },
			// Standalone site, linked from the repo's own header image.
			{ label: 'aicodingdictionary.com', href: 'https://aicodingdictionary.com' },
		],
		logo: {
			light: `${CLOUDINARY}/v1782821584/dictionary-light.png`,
			dark: `${CLOUDINARY}/v1782821584/dictionary-dark.png`,
		},
	},
]
