import { createAnalyticsEngine } from '@coursebuilder/analytics/engine'

import * as database from './providers/database'
import * as derived from './providers/derived'
import * as newsletter from './providers/newsletter'
import * as ga4 from './providers/ga4'
import * as survey from './providers/survey'
import * as youtube from './providers/youtube'

const engine = createAnalyticsEngine({
	database,
	ga4,
	youtube,
	derived,
	newsletter,
	survey,
})

import { catalog as localCatalog } from './catalog'
import { EVERGREEN_FUNNEL_PENDING, promoWindow } from './promos'
import type { QueryOptions, QueryResult, SurfaceName } from './types'
import type { SurfaceName as BaseSurfaceName } from '@coursebuilder/analytics/types'

export const getCatalog = () => Object.values(localCatalog)

export async function query<S extends SurfaceName>(
	surface: S,
	options: QueryOptions = {},
): Promise<QueryResult<S>> {
	if (surface !== 'revenue/promos' && surface !== 'funnel/evergreen') {
		return engine.query(surface as BaseSurfaceName, options) as Promise<
			QueryResult<S>
		>
	}
	const start = Date.now()
	try {
		promoWindow(options)
		const data =
			surface === 'revenue/promos'
				? await database.getRevenueByPromo(options)
				: EVERGREEN_FUNNEL_PENDING
		return {
			ok: true,
			surface,
			range: options.range ?? '30d',
			data,
			meta: { queryTimeMs: Date.now() - start, truncated: false },
		} as QueryResult<S>
	} catch {
		return {
			ok: false,
			surface,
			error: {
				code: 'QUERY_FAILED',
				message: 'Could not read promo analytics.',
			},
			fix: 'Check the explicit UTC window and database availability.',
		}
	}
}

export async function queryMany<S extends SurfaceName>(
	surfaces: S[],
	options?: QueryOptions,
): Promise<{ [K in S]: QueryResult<K> }> {
	const results = await Promise.all(
		surfaces.map((surface) => query(surface, options)),
	)
	return Object.fromEntries(
		results.map((result) => [result.surface, result]),
	) as { [K in S]: QueryResult<K> }
}

export type {
	AnalyticsRange,
	QueryOptions,
	QueryResult,
	SurfaceMap,
	SurfaceName,
} from './types'
export { catalog, type SurfaceEntry } from './catalog'
