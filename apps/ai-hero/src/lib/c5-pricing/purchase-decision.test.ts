import { describe, expect, it, vi } from 'vitest'

import { CB_AUTHORITATIVE_PRICING_CONTRACT_VERSION } from '@coursebuilder/core/schemas'

import { C5_PRODUCT_ID, encodeDecisionRef } from './decision'
import {
	checkC5Duplicate,
	decisionFromSession,
	parseSavedDecision,
	recordC5PurchaseDecision,
	type C5DecisionStore,
	type C5PurchaseRow,
	type RawCheckoutSession,
	type SavedC5Decision,
} from './purchase-decision'

const NOW = new Date('2030-01-05T00:00:00.000Z')
const HASH = '0123456789abcdef'
/** Course Builder's legacy (pre-hook) checkout contract. */
const LEGACY_CONTRACT = 'v1'

const session = (
	metadata: Record<string, string>,
	id = 'cs_test_1',
): RawCheckoutSession => ({
	id,
	metadata: {
		productId: C5_PRODUCT_ID,
		cbPricingContract: CB_AUTHORITATIVE_PRICING_CONTRACT_VERSION,
		decisionRef: encodeDecisionRef(HASH, null),
		engineVersion: 'engine-test',
		policyVersion: 'policy-test',
		accessRestriction: 'none',
		expectedTotalCents: '80000',
		...metadata,
	},
})

describe('decisionFromSession', () => {
	it('saves the versions from the raw session metadata', () => {
		expect(
			decisionFromSession(
				session({ decisionRef: encodeDecisionRef(HASH, 'purchase-cc') }),
				NOW,
			),
		).toEqual({
			v: 1,
			decisionRef: `c5d1.${HASH}.purchase-cc`,
			creditSource: 'purchase-cc',
			codeRef: null,
			basis: null,
			contract: CB_AUTHORITATIVE_PRICING_CONTRACT_VERSION,
			engineVersion: 'engine-test',
			policyVersion: 'policy-test',
			accessRestriction: 'none',
			expectedTotalCents: 80_000,
			checkoutSessionId: 'cs_test_1',
			savedAt: NOW.toISOString(),
		})
	})

	it.each([
		['another product', { productId: 'product-ma254' }],
		['a legacy contract', { cbPricingContract: LEGACY_CONTRACT }],
		['no decision ref', { decisionRef: '' }],
		['a foreign decision ref', { decisionRef: 'xx.0123456789abcdef.-' }],
		['no engine version', { engineVersion: '' }],
		['no policy version', { policyVersion: '' }],
	])('saves nothing for %s', (_, metadata) => {
		expect(decisionFromSession(session(metadata), NOW)).toBeNull()
	})

	it('round-trips through the stored-field parser', () => {
		const saved = decisionFromSession(session({}), NOW)
		expect(parseSavedDecision(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
		expect(parseSavedDecision({ v: 2 })).toBeNull()
		expect(parseSavedDecision('c5d1')).toBeNull()
	})
})

/** An in-memory store with the production store's semantics. */
function memoryStore(rows: C5PurchaseRow[]) {
	const byId = new Map(rows.map((row) => [row.id, { ...row }]))
	const duplicates = new Map<string, readonly string[]>()
	const store: C5DecisionStore = {
		purchase: async (id) => byId.get(id) ?? null,
		saveDecision: vi.fn(async (id: string, decision: SavedC5Decision) => {
			const row = byId.get(id)
			if (row?.decision)
				return row.decision.decisionRef === decision.decisionRef
					? ('saved' as const)
					: ('conflict' as const)
			if (row) byId.set(id, { ...row, decision })
			return 'saved' as const
		}),
		markDuplicate: vi.fn(async (id: string, of: readonly string[]) => {
			duplicates.set(id, of)
		}),
		individualPurchases: async (userId) =>
			[...byId.values()].filter(
				(row) => row.userId === userId && row.productId === C5_PRODUCT_ID,
			),
		spentBy: async (credit) =>
			[...byId.values()]
				.filter((row) => row.decision?.creditSource === credit)
				.map((row) => row.id),
	}
	return { store, duplicates, byId }
}

const row = (over: Partial<C5PurchaseRow>): C5PurchaseRow => ({
	id: 'purchase-1',
	userId: 'user-1',
	productId: C5_PRODUCT_ID,
	status: 'Valid',
	bulkCouponId: null,
	redeemedBulkCouponId: null,
	decision: null,
	...over,
})

const savedWith = (creditSource: string | null, id: string) =>
	decisionFromSession(
		session({ decisionRef: encodeDecisionRef(HASH, creditSource) }, id),
		NOW,
	)!

describe('checkC5Duplicate', () => {
	it('flags a second individual C5 purchase for one buyer', async () => {
		const { store } = memoryStore([row({ id: 'p-old' }), row({ id: 'p-new' })])
		await expect(
			checkC5Duplicate(store, row({ id: 'p-new' })),
		).resolves.toEqual({
			kind: 'duplicate',
			duplicateOf: ['p-old'],
			reasons: ['second-individual-c5'],
		})
	})

	it('ignores refunded purchases and team seats', async () => {
		const { store } = memoryStore([
			row({ id: 'p-refunded', status: 'Refunded' }),
			row({ id: 'p-team', bulkCouponId: 'bulk-1' }),
			row({ id: 'p-new' }),
		])
		await expect(
			checkC5Duplicate(store, row({ id: 'p-new' })),
		).resolves.toEqual({ kind: 'clean' })
		await expect(
			checkC5Duplicate(store, row({ id: 'p-team', bulkCouponId: 'bulk-1' })),
		).resolves.toEqual({ kind: 'clean' })
	})

	it('flags one credit spent by two buyers', async () => {
		const { store } = memoryStore([
			row({ id: 'p-a', userId: 'user-a', decision: savedWith('cc-1', 'cs_a') }),
		])
		await expect(
			checkC5Duplicate(
				store,
				row({
					id: 'p-b',
					userId: 'user-b',
					decision: savedWith('cc-1', 'cs_b'),
				}),
			),
		).resolves.toEqual({
			kind: 'duplicate',
			duplicateOf: ['p-a'],
			reasons: ['credit-spent-twice'],
		})
	})
})

describe('recordC5PurchaseDecision', () => {
	const getSession = (credit: string | null) =>
		vi.fn(async (id: string) =>
			session({ decisionRef: encodeDecisionRef(HASH, credit) }, id),
		)

	it('saves the decision once and leaves an already saved one alone', async () => {
		const { store, byId } = memoryStore([row({ id: 'p-1' })])
		const getCheckoutSession = getSession(null)
		const first = await recordC5PurchaseDecision({
			purchaseId: 'p-1',
			store,
			getCheckoutSession,
			checkoutSessionId: 'cs_1',
			now: () => NOW,
		})
		expect(first).toMatchObject({
			status: 'saved',
			verdict: { kind: 'clean' },
		})
		expect(byId.get('p-1')?.decision?.checkoutSessionId).toBe('cs_1')
		await recordC5PurchaseDecision({
			purchaseId: 'p-1',
			store,
			getCheckoutSession,
			checkoutSessionId: 'cs_1',
			now: () => NOW,
		})
		expect(getCheckoutSession).toHaveBeenCalledTimes(2)
		expect(store.saveDecision).toHaveBeenCalledTimes(2)
	})

	it('flags a changed replay without overwriting the original decision', async () => {
		const original = savedWith('cc-old', 'cs_old')
		const { store, byId } = memoryStore([
			row({ id: 'p-1', decision: original }),
		])
		const result = await recordC5PurchaseDecision({
			purchaseId: 'p-1',
			store,
			getCheckoutSession: getSession('cc-new'),
			checkoutSessionId: 'cs_new',
			now: () => NOW,
		})
		expect(result).toMatchObject({
			status: 'conflict',
			storedRef: original.decisionRef,
		})
		expect(byId.get('p-1')?.decision).toEqual(original)
	})

	it('does not report saved when readback has no row', async () => {
		const { store } = memoryStore([row({ id: 'p-1' })])
		store.saveDecision = async () => 'saved'
		await expect(
			recordC5PurchaseDecision({
				purchaseId: 'p-1',
				store,
				getCheckoutSession: getSession(null),
				checkoutSessionId: 'cs_new',
				now: () => NOW,
			}),
		).rejects.toThrow('purchase-decision-readback-missing')
	})

	it('skips other products and missing purchases', async () => {
		const { store } = memoryStore([
			row({ id: 'p-x', productId: 'product-ma254' }),
		])
		const args = {
			store,
			getCheckoutSession: getSession(null),
			checkoutSessionId: 'cs_1',
			now: () => NOW,
		}
		await expect(
			recordC5PurchaseDecision({ ...args, purchaseId: 'p-x' }),
		).resolves.toEqual({ status: 'not-c5' })
		await expect(
			recordC5PurchaseDecision({ ...args, purchaseId: 'nope' }),
		).resolves.toEqual({ status: 'missing-purchase' })
	})

	it('still checks a legacy session for duplicates', async () => {
		const { store, duplicates } = memoryStore([
			row({ id: 'p-old' }),
			row({ id: 'p-new' }),
		])
		const result = await recordC5PurchaseDecision({
			purchaseId: 'p-new',
			store,
			getCheckoutSession: async (id) =>
				session({ cbPricingContract: LEGACY_CONTRACT }, id),
			checkoutSessionId: 'cs_new',
			now: () => NOW,
		})
		expect(result).toMatchObject({ status: 'legacy' })
		expect(duplicates.get('p-new')).toEqual(['p-old'])
	})

	it('flags at least one of two concurrent purchases spending the same credit', async () => {
		// Two buyers' sessions completed together, each fulfilled by a different
		// path (webhook and reconciler), so their decision runs interleave.
		const { store, duplicates } = memoryStore([
			row({ id: 'p-a', userId: 'user-a' }),
			row({ id: 'p-b', userId: 'user-b' }),
		])
		const run = (purchaseId: string, cs: string) =>
			recordC5PurchaseDecision({
				purchaseId,
				store,
				getCheckoutSession: getSession('cc-1'),
				checkoutSessionId: cs,
				now: () => NOW,
			})
		await Promise.all([run('p-a', 'cs_a'), run('p-b', 'cs_b')])
		expect(duplicates.size).toBeGreaterThan(0)
		const flagged = [...duplicates.entries()]
		for (const [id, of] of flagged)
			expect(of).toEqual([id === 'p-a' ? 'p-b' : 'p-a'])
	})
})
