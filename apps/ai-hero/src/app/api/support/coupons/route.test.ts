import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NewCouponRow, StoredCoupon } from '@/lib/coupon-mint'

const state = vi.hoisted(() => ({
	env: {
		NEXTAUTH_SECRET: 'synthetic-nextauth-secret',
		NEXT_PUBLIC_URL: 'https://example.invalid',
	} as Record<string, string | undefined>,
	auth: {
		user: null as null | { id: string },
		canManageAll: false,
		authMethod: 'anonymous',
	},
	rows: new Map<string, StoredCoupon>(),
	products: new Map([['product-c5', { id: 'product-c5', name: 'C5' }]]),
	createOrFindMerchantCoupon: vi.fn(async () => 'merchant-coupon-25'),
	insertCoupons: vi.fn(),
	log: {
		info: vi.fn(async () => {}),
		warn: vi.fn(async () => {}),
		error: vi.fn(async () => {}),
	},
}))
vi.mock('@/env.mjs', () => ({ env: state.env }))
vi.mock('@/server/logger', () => ({
	log: state.log,
	createRequestContext: () => ({}),
	withLogContext: (_: unknown, fn: () => unknown) => fn(),
	serializeError: () => ({}),
}))
vi.mock('@/db', () => ({
	db: new Proxy(
		{},
		{
			get() {
				throw new Error('Real DB forbidden')
			},
		},
	),
}))
// A 100% mint must never reach Stripe.
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: new Proxy(
		{},
		{
			get() {
				throw new Error('Stripe forbidden')
			},
		},
	),
}))
vi.mock('@/lib/merchant-coupons', () => ({
	createOrFindMerchantCoupon: state.createOrFindMerchantCoupon,
}))
vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: async () => ({
		user: state.auth.user,
		authMethod: state.auth.authMethod,
		ability: {
			can: (action: string, subject: string) =>
				state.auth.canManageAll && action === 'manage' && subject === 'all',
		},
	}),
}))
vi.mock('@/lib/coupon-mint-drizzle', () => ({
	drizzleCouponMintStore: {
		findProduct: async (id: string) => state.products.get(id) ?? null,
		findCoupons: async (ids: string[]) =>
			ids.flatMap((id) => (state.rows.has(id) ? [state.rows.get(id)!] : [])),
		insertCoupons: async (rows: NewCouponRow[]) => {
			state.insertCoupons(rows)
			if (rows.some((row) => state.rows.has(row.id)))
				throw Object.assign(new Error('Duplicate entry'), {
					code: 'ER_DUP_ENTRY',
				})
			for (const row of rows) state.rows.set(row.id, { ...row, usedCount: 0 })
		},
		listCoupons: async ({
			productId,
			label,
		}: {
			productId: string
			label?: string
		}) =>
			[...state.rows.values()].filter(
				(row) =>
					row.restrictedToProductId === productId &&
					(!label || row.fields?.mintedFor === label),
			),
	},
}))

import { GET, POST } from './route'

const url = 'https://example.invalid/api/support/coupons'
function mint(
	body: unknown,
	{
		key = 'synthetic-idempotency-key-0001',
		token = 'synthetic-device-token',
	}: { key?: string | null; token?: string | null } = {},
) {
	return POST(
		new NextRequest(url, {
			method: 'POST',
			body: typeof body === 'string' ? body : JSON.stringify(body),
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(key ? { 'idempotency-key': key } : {}),
			},
		}),
	)
}
const asAdmin = () => {
	state.auth = {
		user: { id: 'admin-user' },
		canManageAll: true,
		authMethod: 'device-token',
	}
}
const free = { productId: 'product-c5', percentageDiscount: 1 }

beforeEach(() => {
	vi.clearAllMocks()
	state.rows.clear()
	state.env.NEXTAUTH_SECRET = 'synthetic-nextauth-secret'
	state.auth = { user: null, canManageAll: false, authMethod: 'anonymous' }
})

describe('POST /api/support/coupons auth', () => {
	it('refuses a missing or unknown token and writes nothing', async () => {
		const res = await mint(free, { token: null })
		expect(res.status).toBe(401)
		expect((await mint(free, { token: 'bogus' })).status).toBe(401)
		expect(state.insertCoupons).not.toHaveBeenCalled()
		expect(state.rows.size).toBe(0)
	})
	it('refuses a valid token without admin ability (PAT, scoped or learner)', async () => {
		state.auth = {
			user: { id: 'contributor' },
			canManageAll: false,
			authMethod: 'personal-access-token',
		}
		expect((await mint(free)).status).toBe(403)
		expect(state.insertCoupons).not.toHaveBeenCalled()
	})
	it('refuses the list for non-admins too', async () => {
		expect(
			(await GET(new NextRequest(`${url}?productId=product-c5`))).status,
		).toBe(401)
	})
	it('fails closed without the id derivation secret', async () => {
		asAdmin()
		state.env.NEXTAUTH_SECRET = undefined
		expect((await mint(free)).status).toBe(503)
		expect(state.insertCoupons).not.toHaveBeenCalled()
	})
})

describe('POST /api/support/coupons minting', () => {
	beforeEach(asAdmin)

	it('mints a 100% coupon with no Stripe call in the free C5 batch shape', async () => {
		const res = await mint({ ...free, label: 'friend-of-joel' })
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.state).toBe('minted')
		expect(body.coupons).toHaveLength(1)
		const [{ id, url: redeemUrl }] = body.coupons
		expect(id).toMatch(/^coupon_[0-9a-f]{24}$/)
		expect(redeemUrl).toBe(`https://example.invalid?code=${id}`)
		expect(state.createOrFindMerchantCoupon).not.toHaveBeenCalled()
		expect(state.insertCoupons.mock.calls[0]![0]).toEqual([
			{
				id,
				restrictedToProductId: 'product-c5',
				percentageDiscount: '1.00',
				maxUses: 1,
				expires: null,
				merchantCouponId: null,
				status: 1,
				default: false,
				fields: { bypassSoldOut: true, mintedFor: 'friend-of-joel' },
			},
		])
		expect(state.log.info).toHaveBeenCalledWith(
			'coupon.minted',
			expect.objectContaining({
				actorUserId: 'admin-user',
				productId: 'product-c5',
				percentageDiscount: 1,
				maxUses: 1,
				quantity: 1,
				label: 'friend-of-joel',
				couponIds: [id],
			}),
		)
	})

	it('returns the same ids for the same Idempotency-Key and never mints twice', async () => {
		const first = await (await mint({ ...free, quantity: 3 })).json()
		const retry = await mint({ ...free, quantity: 3 })
		expect(retry.status).toBe(200)
		const second = await retry.json()
		expect(second.state).toBe('replayed')
		expect(second.coupons).toEqual(first.coupons)
		expect(state.insertCoupons).toHaveBeenCalledTimes(1)
		expect(state.rows.size).toBe(3)
		// A different key is a different batch.
		const other = await (
			await mint(free, { key: 'synthetic-idempotency-key-0002' })
		).json()
		expect(other.coupons[0].id).not.toBe(first.coupons[0].id)
	})

	it('refuses a reused key with different parameters', async () => {
		await mint(free)
		const res = await mint({ ...free, maxUses: 5 })
		expect(res.status).toBe(409)
		expect(state.rows.size).toBe(1)
	})

	it('reuses the admin merchant coupon for partial discounts', async () => {
		const res = await mint({
			productId: 'product-c5',
			percentageDiscount: 0.25,
		})
		expect(res.status).toBe(201)
		expect(state.createOrFindMerchantCoupon).toHaveBeenCalledWith(0.25)
		expect(state.insertCoupons.mock.calls[0]![0][0]).toMatchObject({
			percentageDiscount: '0.25',
			merchantCouponId: 'merchant-coupon-25',
			fields: {},
		})
	})

	it.each([
		['quantity over 50', { ...free, quantity: 51 }],
		['maxUses over 100', { ...free, maxUses: 101 }],
		['zero percent', { ...free, percentageDiscount: 0 }],
		['over 100 percent', { ...free, percentageDiscount: 1.5 }],
		['three decimal places', { ...free, percentageDiscount: 0.255 }],
		['a past expiry', { ...free, expiresAt: '2020-01-01T00:00:00Z' }],
		['a non-slug label', { ...free, label: 'Joel Friend' }],
		['an unknown field', { ...free, email: 'someone@example.test' }],
		['no product', { percentageDiscount: 1 }],
		['bad JSON', '{'],
	])('rejects %s', async (_, body) => {
		expect((await mint(body)).status).toBe(400)
		expect(state.insertCoupons).not.toHaveBeenCalled()
	})

	it('rejects an unknown product', async () => {
		const res = await mint({ ...free, productId: 'product-nope' })
		expect(res.status).toBe(404)
		expect(state.insertCoupons).not.toHaveBeenCalled()
	})

	it.each([null, 'short'])(
		'requires a usable Idempotency-Key (%s)',
		async (key) => {
			expect((await mint(free, { key })).status).toBe(400)
			expect(state.insertCoupons).not.toHaveBeenCalled()
		},
	)
})

describe('GET /api/support/coupons', () => {
	beforeEach(asAdmin)

	it('counts used and unused coupons in a labelled batch', async () => {
		const { coupons } = await (
			await mint({ ...free, quantity: 3, label: 'oct-friends' })
		).json()
		await mint(
			{ ...free, label: 'other-batch' },
			{ key: 'synthetic-idempotency-key-0003' },
		)
		state.rows.get(coupons[0].id)!.usedCount = 1
		const res = await GET(
			new NextRequest(`${url}?productId=product-c5&label=oct-friends`),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.totals).toMatchObject({
			coupons: 3,
			unused: 2,
			usedUp: 1,
			redemptions: 1,
			seats: 3,
		})
		expect(state.insertCoupons).toHaveBeenCalledTimes(2)
	})

	it('requires a product', async () => {
		expect((await GET(new NextRequest(url))).status).toBe(400)
	})
})
