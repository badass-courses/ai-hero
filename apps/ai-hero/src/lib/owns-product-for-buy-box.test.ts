import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	ownsProductForBuyBox,
	type BuyBoxPurchase,
} from './owns-product-for-buy-box'

// Source: PurchaseStatus union in @coursebuilder/core ports/purchase.ts
// (the Drizzle purchase.status column is a free varchar defaulting to Valid).
const STATUSES = ['Valid', 'Refunded', 'Disputed', 'Banned', 'Restricted']
const OWNING = ['Valid', 'Restricted']
const PRODUCT = 'product-a'

// The old inline predicates, kept to assert exactly how the rule differs.
const legacy = {
	// workshops inline/pricing: purchases.some(productId match)
	some: (ps: BuyBoxPurchase[], id: string) =>
		ps.some((p) => p.productId === id),
	// cohorts-query: find() the first purchase of the product, check its status
	findFirst: (ps: BuyBoxPurchase[], id: string) => {
		const first = ps.find((p) => p.productId === id)
		return Boolean(
			first && (first.status === 'Valid' || first.status === 'Restricted'),
		)
	},
	// events/products: Boolean(purchase) from getPurchaseDetails on the first
	// product purchase (no status filter beyond the adapter's visible states)
	booleanPurchase: (ps: BuyBoxPurchase[], id: string) =>
		Boolean(ps.find((p) => p.productId === id)),
}

const purchase = (
	status: string,
	bulk: boolean,
	productId = PRODUCT,
): BuyBoxPurchase => ({
	productId,
	status,
	bulkCouponId: bulk ? 'bulk-1' : null,
})

describe('ownsProductForBuyBox truth table', () => {
	for (const status of STATUSES) {
		for (const bulk of [true, false]) {
			for (const match of [true, false]) {
				const expected = match && !bulk && OWNING.includes(status)
				it(`${status} bulk=${bulk} match=${match} -> ${expected}`, () => {
					const p = purchase(status, bulk, match ? PRODUCT : 'other')
					expect(ownsProductForBuyBox([p], PRODUCT)).toBe(expected)
				})
			}
		}
	}

	it('handles empty, missing and unknown inputs', () => {
		expect(ownsProductForBuyBox([], PRODUCT)).toBe(false)
		expect(ownsProductForBuyBox(undefined, PRODUCT)).toBe(false)
		expect(ownsProductForBuyBox(null, PRODUCT)).toBe(false)
		expect(ownsProductForBuyBox([purchase('Valid', false)], undefined)).toBe(
			false,
		)
		expect(
			ownsProductForBuyBox(
				[{ productId: PRODUCT, status: 'Mystery' }],
				PRODUCT,
			),
		).toBe(false)
		// a projection without status must not compile
		// @ts-expect-error status is required
		expect(ownsProductForBuyBox([{ productId: PRODUCT }], PRODUCT)).toBe(false)
	})
})

describe('ownsProductForBuyBox against each legacy predicate', () => {
	const owned = (status: string) => OWNING.includes(status)

	for (const status of STATUSES) {
		for (const bulk of [true, false]) {
			const list = [purchase(status, bulk)]
			const rule = ownsProductForBuyBox(list, PRODUCT)

			it(`${status} bulk=${bulk}: some() differs only for non-owning or bulk`, () => {
				expect(legacy.some(list, PRODUCT)).toBe(true)
				expect(legacy.booleanPurchase(list, PRODUCT)).toBe(true)
				expect(rule).toBe(owned(status) && !bulk)
				expect(legacy.some(list, PRODUCT) !== rule).toBe(
					!(owned(status) && !bulk),
				)
			})

			it(`${status} bulk=${bulk}: findFirst differs only for bulk`, () => {
				expect(legacy.findFirst(list, PRODUCT)).toBe(owned(status))
				expect(legacy.findFirst(list, PRODUCT) !== rule).toBe(
					owned(status) && bulk,
				)
			})
		}
	}
})

describe('ownsProductForBuyBox mixed lists', () => {
	it('old Refunded then newer Valid owns (findFirst said no)', () => {
		const list = [purchase('Refunded', false), purchase('Valid', false)]
		expect(ownsProductForBuyBox(list, PRODUCT)).toBe(true)
		expect(legacy.findFirst(list, PRODUCT)).toBe(false)
	})

	it('bulk-only team manager does not own (legacy said yes)', () => {
		const list = [purchase('Valid', true)]
		expect(ownsProductForBuyBox(list, PRODUCT)).toBe(false)
		expect(legacy.findFirst(list, PRODUCT)).toBe(true)
		expect(legacy.some(list, PRODUCT)).toBe(true)
		expect(legacy.booleanPurchase(list, PRODUCT)).toBe(true)
	})

	it('bulk plus a redeemed seat owns', () => {
		const list = [purchase('Valid', true), purchase('Valid', false)]
		expect(ownsProductForBuyBox(list, PRODUCT)).toBe(true)
	})

	it('Valid bulk plus a Refunded redeemed seat does not own', () => {
		const list = [purchase('Valid', true), purchase('Refunded', false)]
		expect(ownsProductForBuyBox(list, PRODUCT)).toBe(false)
		expect(legacy.some(list, PRODUCT)).toBe(true)
	})

	it('Valid other product plus Refunded this product does not own', () => {
		const list = [
			purchase('Valid', false, 'other'),
			purchase('Refunded', false),
		]
		expect(ownsProductForBuyBox(list, PRODUCT)).toBe(false)
		expect(legacy.some(list, PRODUCT)).toBe(true)
	})

	it('Valid other product alone does not own', () => {
		expect(
			ownsProductForBuyBox([purchase('Valid', false, 'other')], PRODUCT),
		).toBe(false)
	})
})

describe('ownsProductForBuyBox is display-only (import allowlist)', () => {
	// Every file allowed to import the rule. Adding an importer is a decision:
	// extend this list, and never add ability, entitlement or access code.
	const ALLOWED_IMPORTERS = [
		'app/(commerce)/products/[slug]/page.tsx',
		'app/(content)/events/[slug]/_components/event-pricing-server.tsx',
		'app/(content)/events/[slug]/page.tsx',
		'app/(content)/workshops/_components/inline-mdx-pricing.tsx',
		'app/(content)/workshops/_components/workshop-pricing-server.tsx',
		'app/(content)/workshops/_components/workshop-pricing.tsx',
		'lib/cohorts-query.ts',
	]
	const srcRoot = join(__dirname, '..')

	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			const full = join(dir, name)
			if (statSync(full).isDirectory()) return walk(full)
			return /\.(ts|tsx)$/.test(name) ? [full] : []
		})

	it('only the allowlisted buy-box files import it', () => {
		const importers = walk(srcRoot)
			.map((f) => relative(srcRoot, f).split(sep).join('/'))
			.filter((rel) => !rel.startsWith('lib/owns-product-for-buy-box'))
			.filter((rel) =>
				readFileSync(join(srcRoot, rel), 'utf8').includes(
					'owns-product-for-buy-box',
				),
			)
			.sort()
		expect(importers).toEqual([...ALLOWED_IMPORTERS].sort())
	})
})
