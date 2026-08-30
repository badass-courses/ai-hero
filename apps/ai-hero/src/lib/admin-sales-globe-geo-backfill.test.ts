import { describe, expect, it } from 'vitest'

import {
	GLOBE_GEO_BACKFILL_DEFAULT_PRODUCT_ID,
	parseGlobeGeoBackfillArgs,
} from './admin-sales-globe-geo-backfill'

describe('parseGlobeGeoBackfillArgs', () => {
	it('defaults to a dry-run of the Crash Course product', () => {
		expect(parseGlobeGeoBackfillArgs([])).toEqual({
			allowWrite: false,
			limit: 200,
			productId: GLOBE_GEO_BACKFILL_DEFAULT_PRODUCT_ID,
		})
	})

	it('pins a product unless --all-products is set', () => {
		expect(
			parseGlobeGeoBackfillArgs([
				'--allow-write',
				'--limit',
				'50',
				'--product-id',
				'product-other',
			])
		).toEqual({
			allowWrite: true,
			limit: 50,
			productId: 'product-other',
		})
		expect(parseGlobeGeoBackfillArgs(['--all-products']).productId).toBeNull()
	})

	it('rejects mixing dry-run with writes', () => {
		expect(() =>
			parseGlobeGeoBackfillArgs(['--dry-run', '--allow-write'])
		).toThrow(/dry-run or --allow-write/)
	})
})
