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
