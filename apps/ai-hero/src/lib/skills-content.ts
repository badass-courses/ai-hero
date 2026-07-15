/**
 * Shared content for the /skills surface (HTML page, markdown twin, RSS feed,
 * agent-discovery hints). Single source of truth for hero copy, featured
 * skills, the changelog list id, and editorial guide picks.
 */

export const SKILLS_LIST_ID = 'list_ppwir'
export const SKILLS_PAGE_SIZE = 10

const SKILLS_TITLE_LEAD = 'AI Skills for'
const SKILLS_TITLE_EMPHASIS = 'Real Engineers'

export const SKILLS_HERO = {
	titleLead: SKILLS_TITLE_LEAD,
	titleEmphasis: SKILLS_TITLE_EMPHASIS,
	title: `${SKILLS_TITLE_LEAD} ${SKILLS_TITLE_EMPHASIS}`,
	tagline:
		'A practical skill system for engineers who want to use AI without giving up their standards.',
	installCommand: 'npx skills add mattpocock/skills -y -g',
	repoOwner: 'mattpocock',
	repoName: 'skills',
} as const

export const SKILLS_REPO_URL = `https://github.com/${SKILLS_HERO.repoOwner}/${SKILLS_HERO.repoName}`

export const FEATURED_SKILL_LINKS = [
	{ name: 'grill-me', slug: 'skills-grill-me' },
	{ name: 'grill-with-docs', slug: 'grill-with-docs' },
	{ name: 'domain-model', slug: 'skills-domain-model' },
	{ name: 'to-prd', slug: 'skills-to-prd' },
	{ name: 'to-issues', slug: 'skills-to-issues' },
	{ name: 'tdd', slug: 'skills-tdd' },
	{ name: 'triage', slug: 'burn-through-your-backlog-with-my-triage-skill' },
] as const

export const SKILLS_GUIDE_ITEMS = [
	{
		label: 'Start here',
		title: '5 agent skills I use every day',
		href: '/5-agent-skills-i-use-every-day',
	},
	{
		label: 'Principles',
		title: 'Make codebases AI agents love',
		href: '/how-to-make-codebases-ai-agents-love',
	},
	{
		label: 'In the wild',
		title: 'My Grill Me skill has gone viral',
		href: '/my-grill-me-skill-has-gone-viral',
	},
] as const

/**
 * Sales-copy block for the /skills landing (spec §7 step 2). Ship-ready copy
 * in Matt's voice: what skills are, the problem they solve, how they fit
 * together, and multi-agent compatibility. Content-op friendly — Matt can edit
 * this constant directly (or it can move to CMS `page` content later). No em
 * dashes (DESIGN.md ban).
 */
export const SKILLS_SALES_COPY = {
	eyebrow: 'What are skills?',
	lead: 'Skills are small, sharp instructions you hand your coding agent so it works the way a senior engineer would. Install them once, type a slash command, and the agent follows a process you actually trust.',
	blocks: [
		{
			heading: 'The problem',
			body: 'AI agents are eager and fast, and they will happily write a thousand lines of confident, wrong code. Left alone they skip the boring parts: understanding the problem, questioning your assumptions, writing the test first. That is exactly where the bugs live.',
		},
		{
			heading: 'The fix',
			body: 'A skill encodes one good habit. /grill-me interrogates your plan before a line is written. /tdd forces a failing test first. Each one is a guardrail you drop into any project, so the agent moves fast without cutting the corners you care about.',
		},
		{
			heading: 'How they fit together',
			body: 'The skills form a cycle: from a rough idea, to a domain model, to a PRD, to issues, to tested code, and back around for the next feature. Run one on its own or the whole loop. You stay the engineer; the agent does the typing.',
		},
	],
	compatibility: {
		heading: 'Works in whatever agent you already use',
		body: 'Skills are plain files, not a lock-in platform. Install them once and they run across every major coding agent.',
		agents: ['Claude Code', 'Cursor', 'Windsurf', 'Amp', 'Codex', 'and more'],
	},
} as const

/**
 * Free skills mini-course CTA on the /skills landing (spec §7 step 5).
 *
 * PLACEHOLDER DESTINATION (flag for Vojta): the component is currently
 * UNRENDERED (the mini-course doesn't exist yet — removed from /skills
 * 2026-07-14). The true target is an unresolved content decision (spec §11
 * Q6). `href` points at the latest cohort page meanwhile — the /cohorts
 * index is unused sitewide (never link it; waitlist === latest cohort page).
 */
export const SKILLS_MINI_COURSE_CTA = {
	heading: 'Get the free skills mini-course',
	subheading:
		'A short, email-based walkthrough of the core skills on a real codebase, so you see the whole cycle before you commit to anything.',
	href: '/cohorts/ai-coding-for-real-engineers-m0k0w',
	ctaLabel: 'Start the free course',
} as const

/**
 * Free-lesson CTA target for skill posts (spec §5 step 7). Imported by the
 * skill-extras block appended below the post body.
 *
 * PLACEHOLDER DESTINATION (flag for Vojta): `href` defaults to the real
 * `/newsletter` free-lesson landing. Whether every skill maps to its own lesson
 * slug or shares this one CTA is unresolved (spec §11 Q1) — swap the value here
 * (or make it per-skill) once Matt decides. No template code change needed.
 */
export const SKILLS_FREE_LESSON = {
	href: '/newsletter',
	label: 'Take the free lesson',
	description: 'See the skill in action on a real project.',
} as const
