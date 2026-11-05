import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import {
	EARLY_ACCESS,
	type EarlyAccessPorts,
	type EarlyPurchase,
} from './early-access'
import {
	reconcileEarlyAccessInvoicePayment,
	linkEarlyAccessPayment,
} from './early-access-payment'
import type { EarlyAccessDatabase } from './early-access-purchase'
vi.mock('@/db', () => ({ db: {} }))

function fixture() {
	const invoice = {
		id: 'in_test',
		status: 'paid',
		amount_paid: 19900,
		charge: 'ch_test',
		customer: 'cus_test',
		metadata: {
			accessProvisioning: EARLY_ACCESS,
			earlyAccessPurchaseId: 'early_in_test',
			earlyAccessGrantedAt: '2026-11-05T00:00:00Z',
		},
	} as unknown as Stripe.Invoice
	let linked: EarlyPurchase[] = []
	const transaction = vi.fn()
	const ports: EarlyAccessPorts = {
		invoice: vi.fn(async () => invoice),
		mark: vi.fn(async () => {}),
		purchases: vi.fn(async () => linked),
		preflight: vi.fn(async () => {}),
		create: vi.fn(),
		notify: vi.fn(async () => {}),
		revoke: vi.fn(),
		lock: async (_id, run) => run(),
	}
	const log = { error: vi.fn(async () => {}) }
	const database = { transaction } as unknown as EarlyAccessDatabase
	return {
		invoice,
		ports,
		log,
		database,
		transaction,
		setLinked: (value: EarlyPurchase[]) => {
			linked = value
		},
		run: () =>
			reconcileEarlyAccessInvoicePayment({ database, ports, log }, invoice.id),
	}
}

describe('paid early-access safety boundaries', () => {
	it('does nothing for automatic invoices', async () => {
		const f = fixture()
		f.invoice.metadata!.accessProvisioning =
			'automatic_on_invoice_payment_succeeded'
		expect((await f.run()).state).toBe('not_early_access')
		expect(f.ports.create).not.toHaveBeenCalled()
		expect(f.transaction).not.toHaveBeenCalled()
	})
	it('reports a wrong metadata reference before creating recovery access', async () => {
		const f = fixture()
		f.invoice.metadata!.earlyAccessPurchaseId = 'unrelated_purchase'
		await expect(f.run()).rejects.toThrow('grant reference mismatch')
		expect(f.ports.create).not.toHaveBeenCalled()
		expect(f.transaction).not.toHaveBeenCalled()
		expect(f.log.error).toHaveBeenCalledWith(
			'invoice.early_access.paid_without_grant',
			{ invoiceId: 'in_test' },
		)
	})
	it('alerts, but never restores a revoked grant when it is later paid', async () => {
		const f = fixture()
		f.setLinked([
			{
				id: 'early_in_test',
				status: 'Refunded',
				fields: { earlyAccess: true, invoiceId: 'in_test' },
			},
		])
		expect((await f.run()).state).toBe('paid_after_revoke')
		expect(f.log.error).toHaveBeenCalledWith(
			'invoice.early_access.paid_after_revoke',
			{ invoiceId: 'in_test', purchaseId: 'early_in_test' },
		)
		expect(f.transaction).not.toHaveBeenCalled()
		expect(f.ports.notify).not.toHaveBeenCalled()
	})
	it('normal payment redelivery after a normal refund never restores access or raises a false revoke alarm', async () => {
		const f = fixture()
		f.setLinked([
			{
				id: 'early_in_test',
				status: 'Refunded',
				fields: {
					earlyAccess: true,
					invoiceId: 'in_test',
					earlyAccessPaidAt: 'now',
					earlyAccessChargeId: 'ch_test',
				},
			},
		])
		expect((await f.run()).state).toBe('paid_already_refunded')
		expect(f.log.error).not.toHaveBeenCalled()
		expect(f.transaction).not.toHaveBeenCalled()
	})
	it('refuses an unrelated purchase instead of adopting or creating another', async () => {
		const f = fixture()
		f.setLinked([
			{ id: 'paid_other', status: 'Valid', fields: { invoiceId: 'in_test' } },
		])
		await expect(f.run()).rejects.toThrow('grant identity or status mismatch')
		expect(f.ports.create).not.toHaveBeenCalled()
		expect(f.transaction).not.toHaveBeenCalled()
	})
	it('raises DOUBLE before any payment linkage', async () => {
		const f = fixture()
		f.setLinked([
			{ id: 'p1', status: 'Valid' },
			{ id: 'p2', status: 'Valid' },
		])
		await expect(f.run()).rejects.toThrow('DOUBLE')
		expect(f.transaction).not.toHaveBeenCalled()
	})
	it('checks payment prerequisites before a database transaction', async () => {
		const f = fixture()
		f.invoice.charge = null
		await expect(
			linkEarlyAccessPayment(f.database, f.invoice, 'early_in_test'),
		).rejects.toThrow('no charge or customer')
		f.invoice.status = 'open'
		await expect(
			linkEarlyAccessPayment(f.database, f.invoice, 'early_in_test'),
		).rejects.toThrow('positive paid invoice')
		expect(f.transaction).not.toHaveBeenCalled()
	})
})
