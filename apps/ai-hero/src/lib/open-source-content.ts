/**
 * Curated copy for the /open-source page. Static by design (per
 * `plans/navigation-redesign.md`): there is no `tool` content type, and this
 * list changes a few times a year, so a deploy per edit is the right tradeoff.
 * Star counts are NEVER stored here, they are fetched live at the page level
 * via `getRepoStarCount`.
 */
export type OpenSourceProject = {
	/**
	 * Stable identity for the row. Optional: an entry backed by a repo is
	 * identified by its slug, and this only has to be set for the ones that are
	 * not — the channel has no `owner/name` to be keyed on.
	 */
	id?: string
	/**
	 * GitHub owner, also used for the star lookup.
	 *
	 * Optional because not every row on this page is a repository. Anything
	 * derived from it — the star lookup, the mono line above the heading — is
	 * skipped when it is absent rather than rendered empty or faked.
	 */
	repoOwner?: string
	/** GitHub repo name, also used for the star lookup. */
	repoName?: string
	/**
	 * The mono line above the heading. Defaults to `owner/repo`, which is what
	 * every repo row wants; set it when the row is identified by something else.
	 */
	meta?: string
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
	/**
	 * Artwork slot treatment for a row with no README wordmark to show.
	 *
	 * DESIGN.md rule 6: a missing image inside content is the hatched
	 * placeholder, never a flat box — so the slot stays the same size and the
	 * row keeps the two-column rhythm of the ones around it instead of
	 * collapsing and breaking the list's alignment.
	 */
	glyph?: 'youtube'
}

/** All project artwork lives on the shared Total TypeScript Cloudinary. */
const CLOUDINARY = 'https://res.cloudinary.com/total-typescript/image/upload'

export const OPEN_SOURCE_HERO = {
	eyebrow: 'Open source',
	title: 'Built in the open',
	description:
		'The tools I build for my own work, published as I go. Skills I run every day, a sandbox orchestrator, a dictionary for the jargon, and the channel where the work gets explained.',
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
		// The heading points at OUR page, not the repo. This is the one row whose
		// project has a first-class home on this site: /skills renders the whole
		// catalog with install commands, and sending the primary link off to a
		// README made the site's own page the secondary route to its own content.
		//
		// The repo keeps a chip below, so nothing is lost. The mono line above the
		// heading still reads `mattpocock/skills`, and the star count beside it is
		// still the repo's, so what the row is about is not in doubt.
		href: '/skills',
		links: [
			{ label: 'View the repo', href: 'https://github.com/mattpocock/skills' },
		],
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
	{
		// Last, and the only row that is not a repository. It earns a place
		// because the page's promise is "built in the open" rather than "licensed
		// under MIT" — the channel is where the tools above get shown working, and
		// it was reachable from exactly one fallback link on the whole site.
		//
		// No `repoOwner`/`repoName`, so no star count and no `owner/repo` line: it
		// is identified by its handle instead, which is the thing people actually
		// search for.
		id: 'youtube',
		meta: 'youtube.com/@mattpocockuk',
		name: 'YouTube',
		// The channel's own description, cut to the two-sentence rhythm every
		// other row on this page uses. Not a paraphrase: the line that shipped
		// here was written from the outside ("the work above, explained on
		// video") and led on TypeScript, which is Total TypeScript's subject,
		// not this channel's.
		description:
			'Tips, tricks and tutorials. No vibe coding: this is for real engineers solving real problems.',
		href: 'https://www.youtube.com/@mattpocockuk',
		glyph: 'youtube',
	},
]
