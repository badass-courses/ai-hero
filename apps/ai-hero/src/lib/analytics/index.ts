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

export const { query, queryMany, getCatalog } = engine

export type {
	AnalyticsRange,
	QueryOptions,
	QueryResult,
	SurfaceMap,
	SurfaceName,
} from './types'
export { catalog, type SurfaceEntry } from './catalog'
