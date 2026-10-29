import {
	catalog as baseCatalog,
	type SurfaceEntry as BaseSurfaceEntry,
} from '@coursebuilder/analytics/catalog'
import type { SurfaceName } from './types'
export type SurfaceEntry = Omit<BaseSurfaceEntry, 'name' | 'category'> & {
	name: SurfaceName
	category: BaseSurfaceEntry['category'] | 'learning'
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
	'learning/progress': {
		name: 'learning/progress',
		category: 'learning',
		provider: 'database',
		fn: 'getLearningProgress',
		description:
			'Aggregate learner roster, per-workshop and per-section started/completed funnel, and lesson activity for one productId. Point-in-time counts, no learner identifiers.',
	},
}
