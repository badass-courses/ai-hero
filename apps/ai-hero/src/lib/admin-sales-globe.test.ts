import { drizzle } from 'drizzle-orm/mysql2'
import { describe, expect, it, vi } from 'vitest'

import * as schema from '@/db/schema'

vi.mock('@/db', () => ({ db: null }))

import {
	buildRecentPaidPurchasesQuery,
	mapPurchaseTickerRows,
	normalizeProductId,
	normalizePurchaseLimit,
	type PurchaseTickerRow,
} from './admin-sales-globe'
import { serializePurchaseTickerHit } from './admin-sales-globe-contract'

function row(
	overrides: Partial<PurchaseTickerRow> & Pick<PurchaseTickerRow, 'id'>
): PurchaseTickerRow {
	return {
		createdAt: new Date('2026-08-21T17:00:00.000Z'),
		totalAmount: '49.00',
		productName: 'AI Hero',
		productId: 'product_2',
		country: 'US',
		city: null,
		state: null,
		fields: {},
		sessionIdentifier: null,
		chargeIdentifier: null,
		userName: 'Ada',
		userEmail: 'ada@example.com',
		userImage: 'https://example.com/ada.png',
		bulkCouponMaxUses: 1,
		...overrides,
	}
}

describe('admin sales globe purchase query', () => {
	it('selects only positive paid hits in newest-first stable order', () => {
		const database = drizzle.mock({ schema, mode: 'planetscale' })
		const query = buildRecentPaidPurchasesQuery({
			// SAFETY: drizzle.mock provides the same query-builder surface. Only its
			// uncalled result driver differs from the app's production driver.
			database: database as unknown as typeof import('@/db').db,
			limit: 500,
		})
		const compiled = query.toSQL()

		expect(compiled.sql).toContain('`AI_Purchase`.`status` in (?, ?)')
		expect(compiled.sql).toContain('`AI_Purchase`.`totalAmount` > ?')
		expect(compiled.sql).toContain(
			'order by `AI_Purchase`.`createdAt` desc, `AI_Purchase`.`id` desc'
		)
		expect(compiled.params).toEqual(['Valid', 'Restricted', '0', 500])
	})

	it('joins Stripe session and charge identifiers for finer geo', () => {
		const database = drizzle.mock({ schema, mode: 'planetscale' })
		const query = buildRecentPaidPurchasesQuery({
			database: database as unknown as typeof import('@/db').db,
		})
		const compiled = query.toSQL()

		expect(compiled.sql).toContain('`AI_Purchase`.`city`')
		expect(compiled.sql).toContain('`AI_Purchase`.`state`')
		expect(compiled.sql).toContain('`AI_MerchantSession`.`identifier`')
		expect(compiled.sql).toContain('`AI_MerchantCharge`.`identifier`')
	})

	it('caps limits and falls back to the default for invalid input', () => {
		expect(normalizePurchaseLimit(undefined)).toBe(50)
		expect(normalizePurchaseLimit(Number.NaN)).toBe(50)
		expect(normalizePurchaseLimit(0)).toBe(1)
		expect(normalizePurchaseLimit(12.9)).toBe(12)
		expect(normalizePurchaseLimit(101)).toBe(101)
		expect(normalizePurchaseLimit(501)).toBe(500)
	})

	it('treats all, empty, and oversized product pins as unfiltered', () => {
		expect(normalizeProductId('all')).toBeUndefined()
		expect(normalizeProductId('  ')).toBeUndefined()
		expect(normalizeProductId('product_crash')).toBe('product_crash')
		expect(normalizeProductId('x'.repeat(129))).toBeUndefined()
	})

	it('pins the query to one product when a product id is present', () => {
		const database = drizzle.mock({ schema, mode: 'planetscale' })
		const query = buildRecentPaidPurchasesQuery({
			database: database as unknown as typeof import('@/db').db,
			limit: 500,
			productId: 'product_crash',
		})
		const compiled = query.toSQL()

		expect(compiled.sql).toContain('`AI_Purchase`.`productId` = ?')
		expect(compiled.params).toEqual([
			'Valid',
			'Restricted',
			'0',
			'product_crash',
			500,
		])
	})

	it('maps the exact ticker shape and derives teams only from coupon seats', () => {
		const createdAt = new Date('2026-08-21T17:00:00.123Z')
		const [hit] = mapPurchaseTickerRows([
			row({
				id: 'purchase_team',
				createdAt,
				totalAmount: '398.00',
				productName: null,
				productId: 'product_1',
				country: ' us ',
				userName: null,
				userEmail: 'buyer@example.com',
				userImage: '   ',
				bulkCouponMaxUses: 3,
			}),
		])

		expect(hit).toMatchObject({
			id: 'purchase_team',
			createdAt,
			amount: 398,
			productName: '(unknown)',
			productId: 'product_1',
			country: 'US',
			userName: null,
			userEmail: 'buyer@example.com',
			userImage: null,
			isTeam: true,
			seats: 3,
			lat: 38,
			lng: -97,
			city: null,
			region: null,
		})
		expect(serializePurchaseTickerHit(hit!)).toEqual({
			...hit,
			createdAt: '2026-08-21T17:00:00.123Z',
		})
	})

	it('pings Austin instead of the US centroid when city and state are present', () => {
		const [hit] = mapPurchaseTickerRows([
			row({
				id: 'purchase_austin',
				city: 'Austin',
				state: 'TX',
			}),
		])

		expect(hit).toMatchObject({
			city: 'Austin',
			region: 'TX',
			lat: 30.2672,
			lng: -97.7431,
		})
	})

	it('does not invent a country or team for malformed data', () => {
		const [hit] = mapPurchaseTickerRows([
			row({
				id: 'purchase_individual',
				country: 'USA',
			}),
		])

		expect(hit).toMatchObject({
			country: null,
			isTeam: false,
			seats: null,
			lat: null,
			lng: null,
		})
	})
})
