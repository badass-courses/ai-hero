import { price } from '@ai-hero/front-desk-support/pricing'
import { drizzle } from 'drizzle-orm/mysql2'
import { describe, expect, it, vi } from 'vitest'

import type { C5PricingDeps } from '@/lib/c5-pricing/hook'
import { C5_PRODUCT_ID } from '@/lib/c5-pricing/products'
import {
	SYNTHETIC_LIST,
	SYNTHETIC_POLICY_VERSION,
	syntheticPolicy,
} from '@/lib/c5-pricing/synthetic-policy.test-fixture'

type Row = {
	id: string
	userId: string
	productId: string
	status: string
	bulkCouponId: string | null
}

// The purchases table, read by a fake mysql2 client that applies the
// query's own WHERE terms, so the test sees what the real query selects.
const rows: Row[] = []

function matches(row: Row, term: string, params: unknown[]): boolean {
	const column = term.match(/`(\w+)`(?=\s)/)?.[1] as keyof Row
	if (term.endsWith(' is not null')) return row[column] !== null
	if (term.endsWith(' is null')) return row[column] === null
	const inList = term.match(/ in \(([?, ]+)\)$/)
	if (inList) {
		const values = params.splice(0, inList[1]!.split('?').length - 1)
		return values.includes(row[column])
	}
	if (term.endsWith(' = ?')) return row[column] === params.shift()
	throw new Error(`fake purchases cannot read: ${term}`)
}

const client = {
	query: async (query: string | { sql: string }, params: unknown[] = []) => {
		const sql = typeof query === 'string' ? query : query.sql
		if (sql.includes('from `AI_Product`')) return [[['Cohort Five']], []]
		if (!sql.includes('from `AI_Purchase`')) return [[], []]
		const where = sql.match(/ where \((.+)\) limit \?$/)?.[1]
		if (!where) throw new Error(`fake purchases cannot read: ${sql}`)
		const terms = where.split(' and ')
		const hit = rows.find((row) => {
			const values = [...params]
			return terms.every((term) => matches(row, term, values))
		})
		return [hit ? [[hit.id]] : [], []]
	},
}

const database = drizzle({ client: client as never })
vi.mock('@/db', () => ({
	get db() {
		return database
	},
}))

import { offerStore } from './offer-store'
import { makeOffersPort } from './offers'

const manager = { userId: 'manager', tokenKind: 'learner-token' } as const
const product = {
	appProductId: C5_PRODUCT_ID,
	merchantPriceId: 'price-c5',
	merchantUnit: SYNTHETIC_LIST,
	sourceRefs: ['test:product'],
}
const known = <A>(value: A) => ({ value, sourceRefs: ['test'] })

const deps: C5PricingDeps = {
	policy: async () => ({
		ok: true,
		value: { version: SYNTHETIC_POLICY_VERSION, policy: syntheticPolicy() },
	}),
	quotes: async () => ({ ok: true, value: [] }),
	buyer: async () => ({
		kind: 'buyer',
		email: 'manager@example.test',
		holdsRestrictedPurchase: false,
		holdsValidProductPurchase: false,
		facts: {
			product,
			buyer: { userId: manager.userId, sourceRefs: ['test:user'] },
			quantity: 1,
			facts: {
				order: known('individual' as const),
				alumni: known('none' as const),
				credit: known(null),
				creditUse: known('available' as const),
				existingSeats: known(0),
				legend: known('no' as const),
				ppp: known(null),
			},
		},
	}),
	trustedCountry: async () => null,
	pppPercent: () => 0,
	price,
	engineVersion: 'engine-test',
	now: () => new Date('2030-01-05T00:00:00.000Z'),
	disabled: () => false,
}

const offer = () =>
	makeOffersPort({
		country: 'US',
		store: offerStore,
		pricing: async () => deps,
	}).nextOffer(manager)

describe('offer store', () => {
	it('owns the offer only once the manager redeems a seat of their own bulk order', async () => {
		rows.push({
			id: 'bulk-order',
			userId: manager.userId,
			productId: C5_PRODUCT_ID,
			status: 'Valid',
			bulkCouponId: 'bulk-coupon',
		})
		const unredeemed = await offer()
		expect(unredeemed.state).toBe('standard')
		expect(unredeemed.price).not.toBeNull()
		expect(unredeemed.team?.seatBands.length).toBeGreaterThan(0)

		rows.push({
			id: 'redeemed-seat',
			userId: manager.userId,
			productId: C5_PRODUCT_ID,
			status: 'Valid',
			bulkCouponId: null,
		})
		await expect(offer()).resolves.toMatchObject({
			state: 'owns',
			price: null,
		})
	})
})
