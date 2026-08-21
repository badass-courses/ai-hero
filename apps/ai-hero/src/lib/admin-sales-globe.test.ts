import { drizzle } from 'drizzle-orm/mysql2'
import { describe, expect, it, vi } from 'vitest'

import * as schema from '@/db/schema'

vi.mock('@/db', () => ({ db: null }))

import {
	buildRecentPaidPurchasesQuery,
	mapPurchaseTickerRows,
	normalizeProductId,
	normalizePurchaseLimit,
} from './admin-sales-globe'
import { serializePurchaseTickerHit } from './admin-sales-globe-contract'

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
			'order by `AI_Purchase`.`createdAt` desc, `AI_Purchase`.`id` desc',
		)
		expect(compiled.params).toEqual(['Valid', 'Restricted', '0', 500])
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
			{
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
			},
		])

		expect(hit).toEqual({
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
		})
		expect(serializePurchaseTickerHit(hit!)).toEqual({
			...hit,
			createdAt: '2026-08-21T17:00:00.123Z',
		})
	})

	it('does not invent a country or team for malformed data', () => {
		const [hit] = mapPurchaseTickerRows([
			{
				id: 'purchase_individual',
				createdAt: new Date('2026-08-21T17:00:00.000Z'),
				totalAmount: '49.00',
				productName: 'AI Hero',
				productId: 'product_2',
				country: 'USA',
				userName: 'Ada',
				userEmail: 'ada@example.com',
				userImage: 'https://example.com/ada.png',
				bulkCouponMaxUses: 1,
			},
		])

		expect(hit).toMatchObject({ country: null, isTeam: false, seats: null })
	})
})
