import {
	catalog as baseCatalog,
	type SurfaceEntry as BaseSurfaceEntry,
} from '@coursebuilder/analytics/catalog'
import type { SurfaceName } from './types'
export type SurfaceEntry = Omit<BaseSurfaceEntry, 'name' | 'category'> & {
	name: SurfaceName
	category: BaseSurfaceEntry['category'] | 'learning' | 'newsletter'
}
export const catalog: Record<SurfaceName, SurfaceEntry> = {
	...baseCatalog,
	'revenue/promos': {
		name: 'revenue/promos',
		category: 'revenue',
		provider: 'database',
		fn: 'getRevenueByPromo',
		description:
			'USD gross, refunds and net by promo kind and UTC day, dated by purchase creation. Seat/zero and unclassified records stay visible.',
	},
	'funnel/evergreen': {
		name: 'funnel/evergreen',
		category: 'attribution',
		provider: 'database',
		fn: 'getEvergreenFunnel',
		description:
			'Pending: evergreen entered/clicked/bought daily aggregates await the journey aggregate read. Not zero conversion.',
	},
	'newsletter/signups': {
		name: 'newsletter/signups',
		category: 'newsletter',
		provider: 'newsletter',
		fn: 'getNewsletterSignups',
		description:
			'Newsletter signups from drovr: daily new subscribers by source (ai-hero = site signups, kit = Kit-only arrivals, list-import = imported lists) for the last 30 UTC days, with 7-day and 30-day totals, plus daily confirmed and unsubscribed counts when drovr reports them. Ignores range. A missing day is unavailable, not zero; today is partial. Counts only, no contact identities.',
	},
	'learning/progress': {
		name: 'learning/progress',
		category: 'learning',
		provider: 'database',
		fn: 'getLearningProgress',
		description:
			'Aggregate learner roster, per-workshop and per-section started/completed funnel, and lesson activity for one productId. Point-in-time counts, no learner identifiers.',
	},
	'learning/teams': {
		name: 'learning/teams',
		category: 'learning',
		provider: 'database',
		fn: 'getLearningTeams',
		description:
			'Aggregate team purchases: seats bought, redeemed and unredeemed, members signed in and active in 7 days, and average completion of open lessons. Optional productId. No member identities or organization names.',
	},
	'learning/team': {
		name: 'learning/team',
		category: 'learning',
		provider: 'database',
		fn: 'getLearningTeam',
		description:
			"One team's aggregate summary and workshop funnel, with the team's members as the denominator. Requires teamId (bulk coupon id or bulk purchase id).",
	},
	'learning/team-members': {
		name: 'learning/team-members',
		category: 'learning',
		provider: 'database',
		fn: 'readLearningTeamMembersUncached',
		description:
			'PII: per-member rows for one team, with learner emails and names. AI Hero admins only, never cached, and every read is logged with the actor and team. Requires teamId.',
	},
}
