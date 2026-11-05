import { beforeEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({
	full: {} as any,
	fields: {} as any,
	linked: [] as any[],
	invoices: [] as any[],
	send: vi.fn(async () => ({ ids: ['event'] })),
	query: vi.fn(),
	release: vi.fn(),
	updates: [] as any[],
	getUser: vi.fn(async () => ({
		id: 'u',
		email: 'learner@example.test',
		role: 'user',
	})),
}))
vi.mock('@/env.mjs', () => ({
	env: { STRIPE_SECRET_TOKEN: 'sk_test_synthetic' },
}))
vi.mock('stripe', () => ({
	default: class {
		invoices = {
			retrieve: vi.fn(async (id) => f.invoices.find((i) => i.id === id)),
			update: vi.fn(),
			list: ({ status }: { status: string }) => ({
				async *[Symbol.asyncIterator]() {
					yield* f.invoices.filter((i) => i.status === status)
				},
			}),
		}
	},
}))
vi.mock('@/db', () => ({
	acquireDatabaseConnection: async () => ({
		query: f.query,
		release: f.release,
	}),
	courseBuilderAdapter: {
		getPurchase: async () => f.full,
		getUserById: f.getUser,
		getProduct: async () => ({ type: 'live' }),
	},
	db: {
		select: () => ({
			from: () => ({ leftJoin: () => ({ where: async () => f.linked }) }),
		}),
		update: () => ({
			set: (value: any) => ({
				where: async () => {
					f.updates.push(value)
				},
			}),
		}),
	},
}))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: f.send } }))
vi.mock('./early-access-purchase', () => ({
	createEarlyAccessPurchase: vi.fn(),
}))
import { earlyAccessPorts, reportEarlyAccess } from './early-access-server'
import { EARLY_ACCESS } from './early-access'

beforeEach(() => {
	vi.clearAllMocks()
	f.updates = []
	f.linked = []
	f.invoices = []
	f.query.mockResolvedValue([[{ acquired: 1 }]])
	f.full = {
		id: 'early_in_test',
		userId: 'u',
		productId: 'product',
		status: 'Valid',
		bulkCouponId: null,
		fields: { quantity: 1, invoiceId: 'in_test' },
	}
})

describe('early access runtime boundaries', () => {
	it('uses the paid-path welcome/Discord event and marks delivery receipt', async () => {
		await earlyAccessPorts.notify({ id: 'in_test' } as any, f.full)
		expect(f.send).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'early-access:early_in_test',
				name: 'commerce/new-purchase-created',
				data: expect.objectContaining({
					purchaseId: f.full.id,
					invoiceId: 'in_test',
					quantity: 1,
					productType: 'live',
					customerEmail: 'learner@example.test',
				}),
			}),
		)
		expect(f.updates[0].fields.earlyAccessNotifiedAt).toBeTruthy()
	})
	it('does not resend already-notified grants', async () => {
		f.full.fields.earlyAccessNotifiedAt = '2026-11-05T00:00:00Z'
		await earlyAccessPorts.notify({ id: 'in_test' } as any, f.full)
		expect(f.send).not.toHaveBeenCalled()
	})
	it('emits benefit attachment for individual purchases', async () => {
		f.full.fields.purchaseBenefits = [{ id: 'benefit' }]
		await earlyAccessPorts.notify({ id: 'in_test' } as any, f.full)
		expect(f.send).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'purchase/benefits-attached',
				data: expect.objectContaining({ purchaseBenefitIds: ['benefit'] }),
			}),
		)
	})
	it('sets Refunded and emits the charge-free cleanup event, never a Stripe refund', async () => {
		await earlyAccessPorts.revoke(f.full)
		expect(f.updates[0]).toEqual({ status: 'Refunded' })
		expect(f.send).toHaveBeenCalledWith({
			id: 'early-access-revoke:early_in_test',
			name: 'aihero/early-access.revoke',
			data: { purchaseId: 'early_in_test', invoiceId: 'in_test' },
		})
	})
	it('serializes operator grants and always releases its connection', async () => {
		expect(await earlyAccessPorts.lock('in_test', async () => 'ok')).toBe('ok')
		expect(f.query.mock.calls.map((call) => call[0])).toEqual([
			'SELECT GET_LOCK(?, 0) AS acquired',
			'SELECT RELEASE_LOCK(?)',
		])
		expect(f.release).toHaveBeenCalledTimes(1)
	})
	it('busy grant refuses before executing work', async () => {
		f.query.mockResolvedValueOnce([[{ acquired: 0 }]])
		const work = vi.fn()
		await expect(earlyAccessPorts.lock('in_test', work)).rejects.toThrow(
			'Another early-access',
		)
		expect(work).not.toHaveBeenCalled()
		expect(f.release).toHaveBeenCalled()
	})
	it('report returns masked, read-only past-due/void/uncollectible grants', async () => {
		f.invoices = ['open', 'void', 'uncollectible', 'paid'].map((status) => ({
			id: `in_${status}`,
			status,
			number: 'TEST-1',
			due_date: 1,
			metadata: {
				accessProvisioning: EARLY_ACCESS,
				earlyAccessPurchaseId: 'p',
			},
			customer_email: 'learner@example.test',
		}))
		f.linked = [{ purchase: { id: 'p', status: 'Valid' } }]
		const result = await reportEarlyAccess()
		expect(result.grants).toHaveLength(3)
		expect(JSON.stringify(result)).not.toContain('learner@')
		expect(f.updates).toHaveLength(0)
		expect(f.send).not.toHaveBeenCalled()
	})
})
