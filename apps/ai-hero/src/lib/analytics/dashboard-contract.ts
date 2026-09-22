import type { DashboardData } from '@coursebuilder/analytics/components'

export const DASHBOARD_SECTIONS = [
	'summary',
	'revenue',
	'attribution',
	'shortlinks',
	'traffic',
	'mux',
	'surveys',
	'value-paths',
] as const

export type DashboardSection = (typeof DASHBOARD_SECTIONS)[number]

export type DashboardSectionData = {
	summary: Pick<DashboardData, 'summary'>
	revenue: Pick<
		DashboardData,
		'daily' | 'previousDaily' | 'byProduct' | 'byCountry' | 'recentPurchases'
	>
	attribution: Pick<DashboardData, 'attribution' | 'attributionCoverage'>
	shortlinks: Pick<DashboardData, 'shortlinks'>
	traffic: {
		traffic: DashboardData['traffic']
		traffic180d: DashboardData['traffic']
	}
	mux: Pick<DashboardData, 'mux' | 'muxThumbnails'>
	surveys: Pick<DashboardData, 'surveySegments' | 'surveyCorrelation'>
	'value-paths': Pick<DashboardData, 'valuePaths'>
}

export function createEmptyDashboardData(): DashboardData {
	return {
		summary: { totalRevenue: 0, purchaseCount: 0, avgOrderValue: 0 },
		daily: [],
		previousDaily: [],
		byProduct: [],
		byCountry: [],
		recentPurchases: [],
		attribution: [],
		shortlinks: [],
		traffic: null,
		attributionCoverage: null,
		mux: null,
		muxThumbnails: {},
		surveySegments: null,
		surveyCorrelation: null,
		valuePaths: null,
	}
}

export function mergeDashboardSection<S extends DashboardSection>(
	data: DashboardData,
	section: S,
	payload: DashboardSectionData[S],
): DashboardData {
	switch (section) {
		case 'summary':
			return {
				...data,
				summary: (payload as DashboardSectionData['summary']).summary,
			}
		case 'revenue':
			return { ...data, ...(payload as DashboardSectionData['revenue']) }
		case 'attribution':
			return {
				...data,
				...(payload as DashboardSectionData['attribution']),
			}
		case 'shortlinks':
			return {
				...data,
				shortlinks: (payload as DashboardSectionData['shortlinks']).shortlinks,
			}
		case 'traffic':
			return {
				...data,
				traffic: (payload as DashboardSectionData['traffic']).traffic,
			}
		case 'mux':
			return { ...data, ...(payload as DashboardSectionData['mux']) }
		case 'surveys':
			return { ...data, ...(payload as DashboardSectionData['surveys']) }
		case 'value-paths':
			return {
				...data,
				valuePaths:
					(payload as DashboardSectionData['value-paths']).valuePaths ?? null,
			}
		default:
			throw new Error(`Unsupported analytics dashboard section: ${String(section)}`)
	}
}

export function isCurrentDashboardResponse({
	responseRange,
	activeRange,
	responseGeneration,
	activeGeneration,
}: {
	responseRange: string
	activeRange: string
	responseGeneration: number
	activeGeneration: number
}) {
	return (
		responseRange === activeRange && responseGeneration === activeGeneration
	)
}
