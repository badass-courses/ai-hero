import type {
	SurfaceMap as BaseSurfaceMap,
	QueryOptions as BaseQueryOptions,
	AnalyticsRange,
} from '@coursebuilder/analytics/types'
import type { EvergreenFunnel, PromoRevenue } from './promos'
export * from '@coursebuilder/analytics/types'

export interface SurfaceMap extends BaseSurfaceMap {
	'revenue/promos': PromoRevenue
	'funnel/evergreen': EvergreenFunnel
}
export type SurfaceName = keyof SurfaceMap
export interface QueryOptions extends BaseQueryOptions {
	from?: string
	to?: string
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
