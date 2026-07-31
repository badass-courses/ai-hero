/**
 * Shared content for the /skills surface (HTML page, markdown twin, RSS feed,
 * agent-discovery hints). Single source of truth for hero copy, featured
 * skills, the changelog list id, and editorial guide picks.
 */

export const SKILLS_LIST_ID = 'list_ppwir'
export const SKILLS_PAGE_SIZE = 10

const SKILLS_TITLE_LEAD = 'AI Skills for'
const SKILLS_TITLE_EMPHASIS = 'Real Engineers'

/**
 * Distribution channels for Matt's skills. The page renders this collection
 * directly, so adding another managed marketplace is a data change rather than
 * another installation-card redesign.
 */
export const SKILLS_INSTALL_CHANNELS = [
	{
		id: 'skills-sh',
		label: 'Install the skills',
		/**
		 * Cycles the whole set: this channel installs into whichever agent you
		 * name, so no single mark would be true.
		 */
		mark: 'cycle',
		mode: 'Recommended',
		variant: 'primary',
		command: 'npx skills@latest add mattpocock/skills',
		description:
			'Pick the skills and agents you use. The installer writes editable files into your project.',
		updateLabel: 'Update with',
		updateCommand: 'npx skills update',
		href: 'https://www.skills.sh/mattpocock/skills',
		linkLabel: 'Skills.sh',
	},
	{
		id: 'claude-code',
		label: 'Claude Code',
		/** One agent, one mark — this installs a Claude Code plugin. */
		mark: 'Claude Code',
		mode: 'Plugin',
		variant: 'secondary',
		command: 'claude plugins install mattpocock-skills',
		description:
			'Install the complete set as a managed, read-only plugin from the official marketplace.',
		updateLabel: 'Updates automatically',
		href: 'https://code.claude.com/docs/en/plugins',
		linkLabel: 'Plugin docs',
		/**
		 * What this channel collapses to on a phone. Two commands stacked on a
		 * 390px screen is a wall; the one that serves most readers stays inline
		 * and this points at the other.
		 */
		mobileLabel: 'Using Claude Code? Install as a plugin',
	},
] as const

export const SKILLS_PORTABLE_INSTALL_COMMAND =
	SKILLS_INSTALL_CHANNELS[0].command
export const SKILLS_SH_URL = SKILLS_INSTALL_CHANNELS[0].href
export const SKILLS_SH_BADGE_URL = 'https://www.skills.sh/b/mattpocock/skills'

export const SKILLS_HERO = {
	titleLead: SKILLS_TITLE_LEAD,
	titleEmphasis: SKILLS_TITLE_EMPHASIS,
	title: `${SKILLS_TITLE_LEAD} ${SKILLS_TITLE_EMPHASIS}`,
	tagline:
		'A practical skill system for engineers who want to use AI without giving up their standards.',
	/** Second half of the hero lead (`Skills Page.dc.html` § HEAD). */
	taglineTail: 'Install the ones you want, then type a slash command.',
	/**
	 * The relocated half of the old hero eyebrow. "Free · open source · N
	 * skills" failed the fact test on "the system" and relocated on the second:
	 * open source is a property of the skills, so it is a badge under the
	 * headline. The count moved to the rail foot with the agents.
	 */
	openSourceBadge: 'Free and open source',
	repoOwner: 'mattpocock',
	repoName: 'skills',
} as const

/**
 * The free email course, as the HEAD's side panel (`Skills Page.dc.html`
 * § HEAD). Shorter and more specific than `SkillsCourseCta`'s copy, which is
 * written for a full-width strip under a post.
 */
export const SKILLS_COURSE_PANEL = {
	heading: 'Learn how I actually engineer with these',
	/**
	 * Three lengths, swapped at the same container steps as the hero's layout
	 * (`skills-hero.tsx`), never truncated at runtime. A sentence that gets
	 * shorter because the column did is a different sentence, and picking which
	 * clause survives is an editorial call — `text-overflow` makes it at random.
	 */
	body: {
		/** ≥1080px of hero container: the full argument. */
		full: 'A free email course on the practices these skills came out of: the judgement calls that keep the output at your standard, not just the commands.',
		/** 940–1080px: the contrast survives, the setup goes. */
		mid: 'A free email course on the practices these skills came out of: the judgement calls, not just the commands.',
		/** Under 940px, including mobile: the claim alone. */
		short:
			'A free email course on the practices these skills came out of.',
	},
	ctaLabel: 'Start the email course',
	note: 'No spam. Unsubscribe any time.',
	href: '/skills/subscribe',
} as const

/**
 * What the install rail closes on, replacing the old "Any agent" stat. It sits
 * next to the commands it qualifies rather than in a strip of numbers, because
 * "does this run where I work" is a question about the command, not a metric.
 */
export const SKILLS_RAIL_FOOTER = {
	heading: 'Works with any agent',
	agents: 'Claude Code · Cursor · Codex · Copilot',
	licence: 'MIT',
} as const

/**
 * THE SKILL SET's own head.
 *
 * One word. The section is the catalog on a page whose `h1` already says "AI
 * Skills for Real Engineers", so the heading's whole job is to mark where the
 * list starts — a reader scrolling for the skills is looking for the word
 * "Skills", not for a sentence about them.
 *
 * It has been through two worse versions. It opened on the live count ("21
 * skills, grouped by when you reach for them"), which is the worst available
 * first word for a section head: least memorable thing in the line, makes the
 * heading read as inventory, and re-dates the page every time the CMS gains a
 * skill. Replacing the numeral with the organising idea fixed the number
 * problem and left a heading still explaining itself.
 *
 * So the framing moved to the line beside it, where it belongs: how the list is
 * ordered, and where to start, are the two questions a reader actually has
 * here, and neither is the section's name.
 */
export const SKILLS_SET_SECTION = {
	heading: 'Skills',
	lead: 'Grouped by when you reach for them. Most people start with the main flow.',
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
	eyebrow: 'What is a skill?',
	lead: 'Skills are small, sharp instructions you hand your coding agent so it works the way a senior engineer would. Install the ones you want, type a slash command, and the agent follows a process you actually trust.',
	blocks: [
		{
			heading: 'The problem',
			body: 'An agent is only as good as the process you give it. Left to guess, it writes plausible code that quietly rots the codebase.',
		},
		{
			heading: 'The fix',
			body: 'A skill encodes one good habit (grilling a plan, writing a spec, reviewing a diff), so the agent runs it the same way every time.',
		},
		{
			heading: 'Why it compounds',
			body: "Skills form a chain. Each one's output is the next one's input, so the whole workflow gets better as you tune single steps.",
		},
	],
	compatibility: {
		heading: 'Works in whatever agent you already use',
		body: 'Skills are plain files, not a lock-in platform.',
		agents: ['Claude Code', 'Cursor', 'Codex', 'Amp', 'Copilot'],
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
	// The skills email course, NOT the general newsletter: this CTA sits under a
	// skill post, so it should continue that thread rather than dump the reader
	// at the site-wide signup. Same destination as `SkillsCourseCta`.
	href: '/skills/subscribe',
	label: 'Take the free lesson',
	description: 'See the skill in action on a real project.',
} as const
