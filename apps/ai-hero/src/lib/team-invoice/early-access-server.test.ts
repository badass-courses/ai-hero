import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({
	full: {} as any,
	linked: [] as any[],
	invoices: [] as any[],
	updates: [] as any[],
	updateResult: { rowsAffected: 1 },
	send: vi.fn(async () => ({ ids: ['event'] })),
	query: vi.fn(),
	release: vi.fn(),
	retrieve: vi.fn(),
	search: vi.fn(),
	identity: vi.fn(async () => ({ user: { id: 'identity-user' } })),
	charge: vi.fn(async () => ({ identifier: 'ch_paid' })),
	log: { error: vi.fn(), info: vi.fn() },
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
			retrieve: f.retrieve,
			update: vi.fn(),
			search: (params: unknown) => {
				f.search(params)
				return {
					async *[Symbol.asyncIterator]() {
						yield* f.invoices
					},
				}
			},
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
		getMerchantCharge: f.charge,
	},
	db: {
		select: () => ({
			from: () => ({ leftJoin: () => ({ where: async () => f.linked }) }),
		}),
		update: () => ({
			set: (value: any) => ({
				where: async () => {
					f.updates.push(value)
					return f.updateResult
				},
			}),
		}),
	},
}))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: f.send } }))
vi.mock('@/coursebuilder/email-provider', () => ({
	magicLinkIdentity: { findOrCreateUser: f.identity },
}))
vi.mock('@/server/logger', () => ({ log: f.log }))
vi.mock('./early-access-purchase', () => ({
	createEarlyAccessPurchase: vi.fn(),
	inspectEarlyAccessPurchase: vi.fn(),
}))
import { createEarlyAccessPurchase } from './early-access-purchase'
import { earlyAccessPorts, reportEarlyAccess } from './early-access-server'
import { EARLY_ACCESS } from './early-access'

beforeEach(() => {
	vi.clearAllMocks()
	f.updates = []
	f.linked = []
	f.invoices = []
	f.updateResult = { rowsAffected: 1 }
	f.query.mockResolvedValue([[{ acquired: 1 }]])
	f.charge.mockReset().mockResolvedValue({ identifier: 'ch_paid' })
	f.full = {
		id: 'early_in_test',
		userId: 'u',
		productId: 'product',
		status: 'Valid',
		bulkCouponId: null,
		fields: { quantity: 1, invoiceId: 'in_test', earlyAccess: true },
	}
})

describe('production early access runtime boundaries', () => {
	it('expands customer and product exactly like the paid handler', async () => {
		await earlyAccessPorts.invoice('in_test')
		expect(f.retrieve).toHaveBeenCalledWith('in_test', {
			expand: ['customer', 'lines.data.price.product'],
		})
	})
	it('routes user creation through the paid commerce identity boundary', async () => {
		vi.mocked(createEarlyAccessPurchase).mockImplementationOnce(
			async (_db, _invoice, _at, findUser) => {
				await findUser!('current@example.test')
				return f.full
			},
		)
		await earlyAccessPorts.create(
			{ id: 'in_test' } as any,
			'2026-11-05T00:00:00Z',
		)
		expect(f.identity).toHaveBeenCalledWith('current@example.test')
	})
	it('uses paid-path welcome/Discord events and writes only the notification key', async () => {
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
		const statement = new MySqlDialect().sqlToQuery(f.updates[0].fields)
		expect(statement.sql).toContain('JSON_SET')
		expect(statement.params).toContain('$.earlyAccessNotifiedAt')
		expect(statement.params).not.toContain('$.invoiceId')
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
	it('sets Refunded and emits charge-free cleanup only for one changed row', async () => {
		await earlyAccessPorts.revoke(f.full)
		expect(f.updates[0]).toEqual({ status: 'Refunded' })
		expect(f.send).toHaveBeenCalledWith({
			id: 'early-access-revoke:early_in_test',
			name: 'aihero/early-access.revoke',
			data: { purchaseId: 'early_in_test', invoiceId: 'in_test' },
		})
	})
	it('never sends revocation when the guarded status update matches zero rows', async () => {
		f.updateResult = { rowsAffected: 0 }
		await expect(earlyAccessPorts.revoke(f.full)).rejects.toThrow(
			'no revocation event sent',
		)
		expect(f.send).not.toHaveBeenCalled()
	})
	it('serializes operator grants and releases its connection', async () => {
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
	it('uses metadata search and includes broken paid invoices while masking emails', async () => {
		f.invoices = ['open', 'void', 'uncollectible', 'paid'].map((status) => ({
			id: `in_${status}`,
			status,
			number: 'TEST-1',
			due_date: 1,
			amount_paid: status === 'paid' ? 19900 : 0,
			metadata: {
				accessProvisioning: EARLY_ACCESS,
				earlyAccessPurchaseId: 'p',
			},
			customer_email: 'learner@example.test',
		}))
		f.linked = []
		const result = await reportEarlyAccess()
		expect(result.grants).toHaveLength(4)
		expect(result.grants.every((row) => row.needsRepair)).toBe(true)
		expect(f.search).toHaveBeenCalledWith({
			query: `metadata['accessProvisioning']:'${EARLY_ACCESS}'`,
			limit: 100,
		})
		expect(JSON.stringify(result)).not.toContain('learner@')
		expect(f.updates).toHaveLength(0)
		expect(f.send).not.toHaveBeenCalled()
	})
	it.each(['wrong-id', 'no-charge', 'wrong-amount', 'wrong-charge'])(
		'reports paid grant damage: %s',
		async (damage) => {
			f.invoices = [
				{
					id: 'in_paid',
					status: 'paid',
					amount_paid: 19900,
					charge: 'ch_paid',
					metadata: {
						accessProvisioning: EARLY_ACCESS,
						earlyAccessPurchaseId: 'p',
					},
				},
			]
			const purchase = {
				id: damage === 'wrong-id' ? 'other' : 'p',
				status: 'Valid',
				merchantChargeId: damage === 'no-charge' ? null : 'mc_paid',
				totalAmount: damage === 'wrong-amount' ? 0 : 199,
				fields: {
					earlyAccess: true,
					invoiceId: 'in_paid',
					earlyAccessPaidAt: 'now',
				},
			}
			f.linked = [{ purchase }]
			f.charge.mockResolvedValueOnce({
				identifier: damage === 'wrong-charge' ? 'ch_other' : 'ch_paid',
			})
			expect((await reportEarlyAccess()).grants[0]?.needsRepair).toBe(true)
		},
	)
	it('omits a fully linked paid grant', async () => {
		f.invoices = [
			{
				id: 'in_paid',
				status: 'paid',
				amount_paid: 19900,
				charge: 'ch_paid',
				metadata: {
					accessProvisioning: EARLY_ACCESS,
					earlyAccessPurchaseId: 'p',
				},
			},
		]
		f.linked = [
			{
				purchase: {
					id: 'p',
					status: 'Valid',
					merchantChargeId: 'mc_paid',
					totalAmount: 199,
					fields: {
						earlyAccess: true,
						invoiceId: 'in_paid',
						earlyAccessPaidAt: 'now',
					},
				},
			},
		]
		expect((await reportEarlyAccess()).grants).toHaveLength(0)
	})
})
