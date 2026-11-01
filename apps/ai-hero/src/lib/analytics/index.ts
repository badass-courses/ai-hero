import { createAnalyticsEngine } from '@coursebuilder/analytics/engine'
import { log } from '@/server/logger'
import { reportingOffKitEnabled } from '@/lib/reporting-owned'

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
import { LearningProductNotFoundError } from './learning-progress-query'
import { LearningTeamNotFoundError } from './learning-teams-query'
import { EVERGREEN_FUNNEL_PENDING, promoWindow } from './promos'
import type { QueryOptions, QueryResult, SurfaceName } from './types'
import type { SurfaceName as BaseSurfaceName } from '@coursebuilder/analytics/types'

const LOCAL_SURFACES = [
	'revenue/promos',
	'funnel/evergreen',
	'learning/progress',
	'learning/teams',
	'learning/team',
	'learning/team-members',
] as const
type LocalSurface = (typeof LOCAL_SURFACES)[number]
const isLocalSurface = (surface: SurfaceName): surface is LocalSurface =>
	(LOCAL_SURFACES as readonly string[]).includes(surface)
export const getCatalog = () => [
	...engine.getCatalog().map((entry) =>
		reportingOffKitEnabled() &&
		(entry.name === 'attribution/email-campaigns' ||
			entry.name === 'attribution/email-campaigns/strict')
			? {
					...entry,
					description:
						'Current drovr status for explicitly configured sends, latest journey-transition sample, and labelled local historical Kit snapshots. Unsupported engagement and revenue are unavailable, not zero. Read provider and status before interpreting results.',
				}
			: entry,
	),
	...LOCAL_SURFACES.map((surface) => localCatalog[surface]),
]

export async function query<S extends SurfaceName>(
	surface: S,
	options: QueryOptions = {},
): Promise<QueryResult<S>> {
	if (!isLocalSurface(surface)) {
		return engine.query(surface as BaseSurfaceName, options) as Promise<
			QueryResult<S>
		>
	}
	if (surface === 'learning/progress') return queryLearningProgress(options)
	if (surface === 'learning/teams' || surface === 'learning/team')
		return queryLearningTeams(surface, options)
	if (surface === 'learning/team-members') {
		// PII never flows through the engine, its callers, or queryMany.
		return {
			ok: false,
			surface,
			error: {
				code: 'ROUTE_ONLY',
				message: 'learning/team-members is served only by /api/analytics.',
			},
			fix: 'GET /api/analytics?surface=learning/team-members&teamId=<id> as an AI Hero admin.',
		}
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
	} catch (error) {
		await log.error('analytics.promo.query-failed', { surface, error })
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

async function queryLearningProgress<S extends SurfaceName>(
	options: QueryOptions,
): Promise<QueryResult<S>> {
	const surface = 'learning/progress' as S
	const start = Date.now()
	if (!options.productId) {
		return {
			ok: false,
			surface,
			error: { code: 'PRODUCT_REQUIRED', message: 'productId is required.' },
			fix: 'Pass productId. GET /api/analytics?surface=revenue/products lists product ids.',
		}
	}
	try {
		const data = await database.getLearningProgress(options.productId)
		return {
			ok: true,
			surface,
			range: options.range ?? '30d',
			data,
			meta: { queryTimeMs: Date.now() - start, truncated: false },
		} as QueryResult<S>
	} catch (error) {
		if (error instanceof LearningProductNotFoundError) {
			return {
				ok: false,
				surface,
				error: { code: 'PRODUCT_NOT_FOUND', message: 'Unknown productId.' },
				fix: 'GET /api/analytics?surface=revenue/products lists product ids.',
			}
		}
		await log.error('analytics.learning-progress.query-failed', {
			productId: options.productId,
			error,
		})
		return {
			ok: false,
			surface,
			error: {
				code: 'QUERY_FAILED',
				message: 'Could not read learning progress.',
			},
			fix: 'Retry shortly. Results are cached for five minutes once a read succeeds.',
		}
	}
}

async function queryLearningTeams<S extends SurfaceName>(
	surface: S & ('learning/teams' | 'learning/team'),
	options: QueryOptions,
): Promise<QueryResult<S>> {
	const start = Date.now()
	if (surface === 'learning/team' && !options.teamId) {
		return {
			ok: false,
			surface,
			error: { code: 'TEAM_REQUIRED', message: 'teamId is required.' },
			fix: 'Pass teamId. GET /api/analytics?surface=learning/teams lists team ids.',
		}
	}
	try {
		const data =
			surface === 'learning/team'
				? await database.getLearningTeam(options.teamId!)
				: await database.getLearningTeams(options.productId ?? null)
		return {
			ok: true,
			surface,
			range: options.range ?? '30d',
			data,
			meta: { queryTimeMs: Date.now() - start, truncated: false },
		} as QueryResult<S>
	} catch (error) {
		if (error instanceof LearningTeamNotFoundError) {
			return {
				ok: false,
				surface,
				error: {
					code: 'TEAM_NOT_FOUND',
					message: 'No active team purchase has that teamId.',
				},
				fix: 'GET /api/analytics?surface=learning/teams lists team ids.',
			}
		}
		await log.error('analytics.learning-teams.query-failed', {
			surface,
			productId: options.productId,
			teamId: options.teamId,
			error,
		})
		return {
			ok: false,
			surface,
			error: {
				code: 'QUERY_FAILED',
				message: 'Could not read team progress.',
			},
			fix: 'Retry shortly. Results are cached for five minutes once a read succeeds.',
		}
	}
}

export async function queryMany<S extends SurfaceName>(
	surfaces: S[],
	options?: QueryOptions,
): Promise<{ [K in S]: QueryResult<K> }> {
	if (!surfaces.some(isLocalSurface)) {
		return engine.queryMany(surfaces as BaseSurfaceName[], options) as Promise<{
			[K in S]: QueryResult<K>
		}>
	}
	const baseSurfaces = surfaces.filter(
		(surface) => !isLocalSurface(surface),
	) as BaseSurfaceName[]
	const [baseResults, localResults] = await Promise.all([
		baseSurfaces.length
			? engine.queryMany(baseSurfaces, options)
			: Promise.resolve({}),
		Promise.all(
			surfaces.filter(isLocalSurface).map((surface) => query(surface, options)),
		),
	])
	return {
		...baseResults,
		...Object.fromEntries(
			localResults.map((result) => [result.surface, result]),
		),
	} as { [K in S]: QueryResult<K> }
}

export type {
	AnalyticsRange,
	QueryOptions,
	QueryResult,
	SurfaceMap,
	SurfaceName,
} from './types'
export { catalog, type SurfaceEntry } from './catalog'
