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

// The old inline predicates, kept to show what changed.
const legacy = {
	someByProduct: (ps: BuyBoxPurchase[], id: string) =>
		ps.some((p) => p.productId === id),
	findFirstByProduct: (ps: BuyBoxPurchase[], id: string) => {
		const first = ps.find((p) => p.productId === id)
		return Boolean(
			first && (first.status === 'Valid' || first.status === 'Restricted'),
		)
	},
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
		expect(ownsProductForBuyBox([{ productId: PRODUCT }], PRODUCT)).toBe(false)
	})
})

describe('ownsProductForBuyBox mixed lists', () => {
	it('old Refunded then newer Valid owns', () => {
		const list = [purchase('Refunded', false), purchase('Valid', false)]
		expect(ownsProductForBuyBox(list, PRODUCT)).toBe(true)
		expect(legacy.findFirstByProduct(list, PRODUCT)).toBe(false)
	})

	it('bulk-only team manager does not own', () => {
		const list = [purchase('Valid', true)]
		expect(ownsProductForBuyBox(list, PRODUCT)).toBe(false)
		expect(legacy.findFirstByProduct(list, PRODUCT)).toBe(true)
		expect(legacy.someByProduct(list, PRODUCT)).toBe(true)
	})

	it('bulk plus a redeemed seat owns', () => {
		const list = [purchase('Valid', true), purchase('Valid', false)]
		expect(ownsProductForBuyBox(list, PRODUCT)).toBe(true)
	})

	it('refunded-only no longer reads as owned (legacy some() did)', () => {
		const list = [purchase('Refunded', false)]
		expect(ownsProductForBuyBox(list, PRODUCT)).toBe(false)
		expect(legacy.someByProduct(list, PRODUCT)).toBe(true)
	})

	it('other-product purchases are ignored', () => {
		const list = [purchase('Valid', false, 'other')]
		expect(ownsProductForBuyBox(list, PRODUCT)).toBe(false)
	})
})

describe('ownsProductForBuyBox is display-only (import fence)', () => {
	const srcRoot = join(__dirname, '..')
	const accessPath = (rel: string) =>
		/(^|\/)(ability|entitlements?[^/]*|access[^/]*|workshop-access-boundary[^/]*)(\/|\.|$)/i.test(
			rel,
		)

	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			const full = join(dir, name)
			if (statSync(full).isDirectory()) return walk(full)
			return /\.(ts|tsx)$/.test(name) ? [full] : []
		})

	it('no ability, entitlement or access file imports it', () => {
		const offenders = walk(srcRoot)
			.map((f) => relative(srcRoot, f).split(sep).join('/'))
			.filter((rel) => !rel.startsWith('lib/owns-product-for-buy-box'))
			.filter(accessPath)
			.filter((rel) =>
				readFileSync(join(srcRoot, rel), 'utf8').includes(
					'owns-product-for-buy-box',
				),
			)
		expect(offenders).toEqual([])
	})
})
