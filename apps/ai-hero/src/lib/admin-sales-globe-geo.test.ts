import { describe, expect, it } from 'vitest'

import {
	billingAddressForPurchase,
	normalizePostal,
	readCachedGlobeLocation,
	resolveGlobeLocation,
	type GlobeGeoDatasets,
} from './admin-sales-globe-geo'

const datasets: GlobeGeoDatasets = {
	postal: { '94107': [37.7609, -122.3989] },
	cities: {
		'austin|US': [30.2672, -97.7431],
		'austin|US|tx': [30.2672, -97.7431],
		'springfield|US': [39.7817, -89.6501],
		'springfield|US|il': [39.7817, -89.6501],
		'springfield|US|mo': [37.209, -93.2923],
		'krakow|PL': [50.0647, 19.945],
	},
	regions: {
		'US|tx': [31.9686, -99.9018],
		'US|texas': [31.9686, -99.9018],
		'PL|malopolskie': [49.838, 20.261],
	},
	countries: {
		US: [38, -97],
		PL: [52, 20],
		TH: [15, 100],
	},
}

describe('resolveGlobeLocation', () => {
	it('pings a US ZIP before city, region, or country', () => {
		expect(
			resolveGlobeLocation(
				{
					country: 'US',
					city: 'Austin',
					region: 'TX',
					postal: '94107-1234',
				},
				datasets
			)
		).toEqual({
			lat: 37.7609,
			lng: -122.3989,
			city: 'Austin',
			region: 'TX',
			precision: 'postal',
		})
	})

	it('uses the state-qualified city when the same name exists twice', () => {
		expect(
			resolveGlobeLocation(
				{ country: 'US', city: 'Springfield', region: 'MO' },
				datasets
			)
		).toEqual({
			lat: 37.209,
			lng: -93.2923,
			city: 'Springfield',
			region: 'MO',
			precision: 'city',
		})
	})

	it('falls back to region, then country, and stays null without a coordinate', () => {
		expect(
			resolveGlobeLocation({ country: 'US', region: 'Texas' }, datasets)
		).toMatchObject({ lat: 31.9686, lng: -99.9018, precision: 'region' })
		expect(resolveGlobeLocation({ country: 'TH' }, datasets)).toEqual({
			lat: 15,
			lng: 100,
			city: null,
			region: null,
			precision: 'country',
		})
		expect(resolveGlobeLocation({ country: 'ZZ' }, datasets)).toBeNull()
		expect(resolveGlobeLocation({ country: null }, datasets)).toBeNull()
	})

	it('resolves a non-US city instead of the country centroid', () => {
		expect(
			resolveGlobeLocation({ country: 'PL', city: 'Kraków' }, datasets)
		).toEqual({
			lat: 50.0647,
			lng: 19.945,
			city: 'Kraków',
			region: null,
			precision: 'city',
		})
	})
})

describe('billingAddressForPurchase', () => {
	it('keeps Stripe billing only when the address country matches the purchase', () => {
		expect(
			billingAddressForPurchase('US', {
				city: 'Austin',
				region: 'TX',
				postal: '78701',
				country: 'US',
			})
		).toEqual({
			city: 'Austin',
			region: 'TX',
			postal: '78701',
			country: 'US',
		})
		expect(
			billingAddressForPurchase('TH', {
				city: 'Austin',
				region: 'TX',
				postal: '78701',
				country: 'US',
			})
		).toBeNull()
		expect(billingAddressForPurchase('US', null)).toBeNull()
	})
})

describe('normalizePostal and cached globe fields', () => {
	it('extracts a US ZIP5 and ignores junk', () => {
		expect(normalizePostal('US', '94107-1234')).toBe('94107')
		expect(normalizePostal('US', ' 94107 ')).toBe('94107')
		expect(normalizePostal('PL', '31-042')).toBe('31-042')
		expect(normalizePostal('US', 'nope')).toBeNull()
	})

	it('reads a finer cached ping and ignores a country-only cache', () => {
		expect(
			readCachedGlobeLocation({
				globe: {
					lat: 30.2672,
					lng: -97.7431,
					city: 'Austin',
					region: 'TX',
					precision: 'city',
				},
			})
		).toMatchObject({ lat: 30.2672, lng: -97.7431, precision: 'city' })
		expect(
			readCachedGlobeLocation({
				globe: { lat: 38, lng: -97, precision: 'country' },
			})
		).toBeNull()
		expect(readCachedGlobeLocation({ attribution: { source: 'x' } })).toBeNull()
	})
})
