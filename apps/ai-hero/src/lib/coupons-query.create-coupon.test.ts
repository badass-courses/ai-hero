import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	const inserted: Record<string, unknown>[] = []
	return {
		inserted,
		ability: { can: vi.fn((_action: string, _subject: string) => false) },
		transaction: vi.fn(async (fn: (trx: unknown) => Promise<void>) =>
			fn({
				insert: () => ({
					values: async (row: Record<string, unknown>) => {
						inserted.push(row)
					},
				}),
			}),
		),
		send: vi.fn(async () => undefined),
	}
})

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/db', () => ({
	db: { transaction: mocks.transaction },
	courseBuilderAdapter: {},
}))
vi.mock('@/db/schema', () => ({ coupon: {}, merchantCoupon: {} }))
vi.mock('@/coursebuilder/stripe-provider', () => ({ stripeProvider: {} }))
vi.mock('@/inngest/functions/coupon/grant-coupon-entitlements', () => ({
	GRANT_COUPON_ENTITLEMENTS_EVENT: 'coupon/grant-entitlements',
}))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: mocks.send } }))
vi.mock('@/lib/default-coupon-invalidation', () => ({
	invalidateDefaultCoupon: vi.fn(async () => undefined),
}))
vi.mock('@/lib/merchant-coupons', () => ({
	createOrFindMerchantCoupon: vi.fn(async () => 'mc_1'),
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(async () => ({ ability: mocks.ability })),
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

const { createCoupon } = await import('./coupons-query')

const valid = {
	quantity: '2',
	maxUses: 1,
	discountType: 'percentage' as const,
	percentageDiscount: '0.25',
	status: 1,
	default: false,
	fields: {},
}
const contributor = (action: string, subject: string) =>
	subject === 'Content' && ['create', 'read', 'update'].includes(action)
const admin = (action: string, subject: string) =>
	action === 'manage' && subject === 'all'

describe('createCoupon is admin-only and bounded (sec-049)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.inserted.length = 0
	})

	it('creates nothing for a contributor', async () => {
		mocks.ability.can.mockImplementation(contributor)
		await expect(
			createCoupon({ ...valid, percentageDiscount: '1', quantity: '1000' }),
		).resolves.toEqual([])
		expect(mocks.transaction).not.toHaveBeenCalled()
		expect(mocks.send).not.toHaveBeenCalled()
	})

	it('creates the requested codes for an admin', async () => {
		mocks.ability.can.mockImplementation(admin)
		const codes = await createCoupon(valid)
		expect(codes).toHaveLength(2)
		expect(mocks.inserted).toHaveLength(2)
	})

	it.each([
		['quantity above 1000', { quantity: '1001' }],
		['quantity of 0', { quantity: '0' }],
		['non-numeric quantity', { quantity: '1e9' }],
		['discount above 100%', { percentageDiscount: '1.5' }],
		['negative discount', { percentageDiscount: '-0.5' }],
		['maxUses of 0', { maxUses: 0 }],
	])('refuses %s', async (_label, patch) => {
		mocks.ability.can.mockImplementation(admin)
		await expect(createCoupon({ ...valid, ...patch })).rejects.toThrow()
		expect(mocks.inserted).toHaveLength(0)
	})

	it('never writes columns the form does not send', async () => {
		mocks.ability.can.mockImplementation(admin)
		await createCoupon({
			...valid,
			quantity: '1',
			usedCount: -1000,
			id: 'attacker-chosen',
		} as never)
		expect(mocks.inserted[0]).not.toHaveProperty('usedCount')
		expect(mocks.inserted[0]!.id).not.toBe('attacker-chosen')
	})
})
