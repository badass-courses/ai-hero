/**
 * Editorial config for the /courses "Learn with Matt" catalog page — the
 * single place to tune copy without touching layout. Ship-ready copy per
 * Amy's 3-tier course roadmap (nav-redesign decisions doc): Crash Course
 * (beginner, planned) → AI Coding for Real Engineers (flagship cohort, live)
 * → Building a Software Factory (advanced/teams, planned).
 *
 * NEVER reference the draft Crash Course product here — planned tiers are
 * copy-only until their products publish (deploy-ordering rule).
 */

export const COURSES_HERO = {
	eyebrow: 'Courses',
	title: 'Learn with Matt',
	intro:
		'Structured, hands-on courses that take you from your first AI-assisted commit to running an AI-powered engineering team. Pick the tier that matches where you are; the path is designed to grow with you.',
} as const

export type CourseTier = {
	tier: 1 | 2 | 3
	/** Mono journey strip above the row, e.g. "Tier 1 · Start here". */
	label: string
	title: string
	/** ResourceRow typeLabel for coming-soon rows. */
	audienceLabel: string
	description: string
	status: 'coming-soon' | 'flagship'
}

export const COURSE_TIERS: readonly CourseTier[] = [
	{
		tier: 1,
		label: 'Tier 1 · Start here',
		title: 'AI Coding Crash Course',
		audienceLabel: 'Beginner friendly',
		description:
			'Your first real wins with AI coding. Built for beginners, including folks who have never shipped code before: go from a blank editor to working software you actually understand. Join the list below to hear the moment it opens.',
		status: 'coming-soon',
	},
	{
		tier: 2,
		label: 'Tier 2 · The flagship',
		title: 'AI Coding for Real Engineers',
		audienceLabel: 'Cohort',
		// Live description comes from the cohort resource; this is unused.
		description: '',
		status: 'flagship',
	},
	{
		tier: 3,
		label: 'Tier 3 · For teams',
		title: 'Building a Software Factory',
		audienceLabel: 'Advanced · For teams',
		description:
			'For engineers and leaders inside software companies. Turn individual AI coding wins into a system your whole team runs on: agents, standards, and pipelines that ship production software at a pace that feels unfair. Join the list below to hear when it opens.',
		status: 'coming-soon',
	},
] as const

export const FLAGSHIP_WAITLIST = {
	badge: 'Waitlist open',
	description:
		'The flagship: one week, semi-live, with Matt. Everyone gets the videos and exercises, plus live sessions through the week. The next cohort is being scheduled now; join the waitlist for first pick of seats when dates land.',
} as const

export const COURSES_NEWSLETTER = {
	anchorId: 'join',
	title: 'Be first to hear when a course opens',
	byline:
		'One email when enrollment opens or a new course ships. No spam, unsubscribe whenever.',
} as const
