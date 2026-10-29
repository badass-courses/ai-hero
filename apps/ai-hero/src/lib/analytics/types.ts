import type {
	SurfaceMap as BaseSurfaceMap,
	QueryOptions as BaseQueryOptions,
	AnalyticsRange,
} from '@coursebuilder/analytics/types'
import type { EvergreenFunnel, PromoRevenue } from './promos'
import type { LearningProgress } from './learning-progress'
import type {
	LearningTeamMembers,
	LearningTeamProgress,
	LearningTeams,
} from './learning-teams'
export * from '@coursebuilder/analytics/types'

export interface SurfaceMap extends BaseSurfaceMap {
	'revenue/promos': PromoRevenue
	'funnel/evergreen': EvergreenFunnel
	'learning/progress': LearningProgress
	'learning/teams': LearningTeams
	'learning/team': LearningTeamProgress
	/** PII. Served only by the analytics route, for AI Hero admins. */
	'learning/team-members': LearningTeamMembers
}
export type SurfaceName = keyof SurfaceMap
export interface QueryOptions extends BaseQueryOptions {
	from?: string
	to?: string
	/** A team's bulk coupon id, or one of its bulk purchase ids. */
	teamId?: string
}
export type QueryResult<S extends SurfaceName> =
	| {
			ok: true
			surface: S
			range: AnalyticsRange
			data: SurfaceMap[S]
			meta: { queryTimeMs: number; truncated: boolean }
	  }
	| {
			ok: false
			surface: S
			error: { message: string; code: string }
			fix: string
	  }
