import type { PricingPolicyData } from '@ai-hero/front-desk-support/pricing'

/**
 * A synthetic Cohort-005-shaped policy for tests. Every number and date here
 * is invented: the real policy arrives from front-desk at runtime and never
 * lives in this public repo.
 */
export const SYNTHETIC_POLICY_VERSION = 'synthetic-cohort@test.1'
export const SYNTHETIC_POLICY_PRODUCT = 'synthetic-cohort'
export const SYNTHETIC_LIST = 100_000
export const SYNTHETIC_LEGEND_PRODUCTS = [
	'product-3vfob',
	'product-9wdta',
	'product-wdhub',
	'product-7t9ek',
	'product-pqkk5',
	'product-ma254',
] as const

const ruled = <A>(field: string, value: A) => ({
	source: `${SYNTHETIC_POLICY_VERSION}#${field}`,
	value,
})

export const SYNTHETIC_WINDOWS = {
	opensAt: '2030-01-01T08:00:00.000Z',
	earlyEndsAt: '2030-02-01T08:00:00.000Z',
	checkoutStopsAt: '2030-03-01T07:30:00.000Z',
	closesAt: '2030-03-01T08:00:00.000Z',
} as const

export function syntheticPolicy(
	over: Partial<PricingPolicyData> = {},
): PricingPolicyData {
	return {
		version: SYNTHETIC_POLICY_VERSION,
		product: SYNTHETIC_POLICY_PRODUCT,
		enabled: true,
		list: SYNTHETIC_LIST,
		opensAt: ruled('opensAt', SYNTHETIC_WINDOWS.opensAt),
		earlyEndsAt: ruled('earlyEndsAt', SYNTHETIC_WINDOWS.earlyEndsAt),
		checkoutStopsAt: ruled(
			'checkoutStopsAt',
			SYNTHETIC_WINDOWS.checkoutStopsAt,
		),
		closesAt: ruled('closesAt', SYNTHETIC_WINDOWS.closesAt),
		newBuyerEarlyPercent: ruled('newBuyerEarlyPercent', 20),
		alumniPercent: ruled('alumniPercent', 35),
		creditAmounts: ruled('creditAmounts', [5_000, 10_000, 15_000]),
		legend: ruled('legend', {
			percent: 50,
			credit: 5_000,
			manifest: {
				version: 'synthetic-legend@test',
				products: [...SYNTHETIC_LEGEND_PRODUCTS],
				excludes: ['product-qocpc'],
				ownership: 'own-purchases',
				statuses: ['Valid', 'Restricted'],
			},
		}),
		ppp: ruled('ppp', 'better-of-formula-or-ppp'),
		teamBands: ruled('teamBands', {
			early: [
				{ minSeats: 1, percent: 20 },
				{ minSeats: 5, percent: 25 },
				{ minSeats: 10, percent: 30 },
				{ minSeats: 30, percent: 40 },
			],
			standard: [
				{ minSeats: 1, percent: 0 },
				{ minSeats: 5, percent: 10 },
				{ minSeats: 10, percent: 20 },
				{ minSeats: 30, percent: 30 },
			],
		}),
		...over,
	}
}
