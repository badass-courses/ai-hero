import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sealGiftCookie } from './gift-cookie'
import { C5_PRODUCT_ID } from './products'
import { syntheticPolicy } from './synthetic-policy.test-fixture'

const state = vi.hoisted(() => ({
	cookie: undefined as string | undefined,
	coupon: null as Record<string, unknown> | null,
	taken: 0,
	override: false,
}))
const query = vi.hoisted(() =>
	vi.fn(async (sql: string) => [
		sql.includes('COUNT(*)')
			? [{ taken: state.taken }]
			: state.coupon
				? [state.coupon]
				: [],
	]),
)
vi.mock('next/headers', () => ({
	cookies: async () => ({ get: () => ({ value: state.cookie }) }),
}))
vi.mock('@/env.mjs', () => ({
	env: { NEXTAUTH_SECRET: 'fixture-signing-secret' },
}))
vi.mock('@/db', () => ({
	acquireDatabaseConnection: async () => ({ query, release: vi.fn() }),
}))
vi.mock('./switch-server', () => ({ c5PricingClosed: async () => true }))
vi.mock('./config', () => ({ c5PricingDisabled: () => state.override }))
vi.mock('./front-desk-client', () => ({
	frontDeskData: () => ({
		policy: async () => ({
			ok: true,
			value: { version: 'fixture', policy: syntheticPolicy() },
		}),
	}),
}))
vi.mock('./buyer-opening-server', () => ({
	c5OpeningWindow: async () => ({
		opensAt: Date.parse('2030-01-01'),
		checkoutStopsAt: Date.parse('2030-03-01'),
		closesAt: Date.parse('2030-03-01'),
	}),
}))
import { signedGiftFact } from './gift-server'

afterEach(() => {
	vi.useRealTimers()
})

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2029-12-20T00:00:00.000Z'))
	state.override = false
	state.taken = 0
	state.cookie = sealGiftCookie(
		{
			v: 1,
			productId: C5_PRODUCT_ID,
			codeRef: 'fixture',
			expiresAt: Date.parse('2030-02-15T00:00:00.000Z'),
		},
		'fixture-signing-secret',
	)
	state.coupon = {
		id: 'fixture',
		status: 1,
		maxUses: 5,
		expires: new Date('2030-02-15T00:00:00.000Z'),
		restrictedToProductId: C5_PRODUCT_ID,
		fields: {
			purpose: 'legend-gift',
			targetPriceCents: 40_000,
			quantityLimit: 1,
			stackable: false,
		},
	}
	query.mockClear()
})

describe('fresh server gift verification while the switch is off', () => {
	it('accepts a signed cookie only with the fresh product coupon and ledger', async () => {
		await expect(signedGiftFact()).resolves.toMatchObject({
			value: { unitPrice: 40_000, usesTaken: 0 },
		})
		expect(query).toHaveBeenCalledTimes(2)
		state.taken = 5
		await expect(signedGiftFact()).resolves.toMatchObject({ value: null })
	})
	it('rejects forged and other-product cookies before reading the database', async () => {
		for (const value of [
			state.cookie + 'forged',
			sealGiftCookie(
				{
					v: 1,
					productId: 'fixture-other',
					codeRef: 'fixture',
					expiresAt: Date.parse('2030-02-15T00:00:00.000Z'),
				},
				'fixture-signing-secret',
			),
		]) {
			state.cookie = value
			await expect(signedGiftFact()).resolves.toMatchObject({ value: null })
		}
		expect(query).not.toHaveBeenCalled()
	})
	it('rejects cookie-only, other-product and expired server coupons', async () => {
		const coupon = state.coupon!
		for (const row of [
			null,
			{ ...coupon, restrictedToProductId: 'fixture-other' },
			{ ...coupon, expires: new Date('2020-01-01') },
		]) {
			state.coupon = row
			await expect(signedGiftFact()).resolves.toMatchObject({ value: null })
		}
	})
	it('honors the emergency override even with a valid coupon and signed cookie', async () => {
		state.override = true
		await expect(signedGiftFact()).resolves.toMatchObject({ value: null })
	})
})
