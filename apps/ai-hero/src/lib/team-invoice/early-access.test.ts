import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import {
	AUTOMATIC_ACCESS,
	EARLY_ACCESS,
	assertGrantable,
	grantEarlyAccess,
	grantMetadata,
	invoiceCustomerEmail,
	needsReview,
	revokeEarlyAccess,
	type EarlyAccessPorts,
	type EarlyPurchase,
} from './early-access'
import { earlyAccessRequest } from './early-access-client'

function fixture() {
	let invoice = {
		id: 'in_test',
		number: 'TEST-0001',
		status: 'open',
		amount_paid: 0,
		customer: 'cus_test',
		customer_email: 'learner@example.test',
		due_date: 1,
		metadata: { accessProvisioning: AUTOMATIC_ACCESS },
		lines: {
			has_more: false,
			data: [{ amount: 19900, quantity: 1, price: { product: 'prod_test' } }],
		},
	} as unknown as Stripe.Invoice
	let purchases: EarlyPurchase[] = []
	const ports: EarlyAccessPorts = {
		invoice: vi.fn(async () => structuredClone(invoice)),
		mark: vi.fn(async (_id, metadata) => {
			invoice = { ...invoice, metadata: { ...invoice.metadata, ...metadata } }
		}),
		purchases: vi.fn(async () => structuredClone(purchases)),
		preflight: vi.fn(async () => {}),
		create: vi.fn(async (inv, at) => {
			const p = {
				id: 'early_in_test',
				status: 'Valid',
				fields: {
					earlyAccess: true,
					invoiceId: inv.id,
					earlyAccessGrantedAt: at,
				},
			}
			purchases.push(p)
			return p
		}),
		notify: vi.fn(async () => {}),
		revoke: vi.fn(async (p) => {
			purchases = purchases.map((item) =>
				item.id === p.id ? { ...item, status: 'Refunded' } : item,
			)
		}),
		lock: async (_id, work) => work(),
	}
	return {
		ports,
		invoice: () => invoice,
		purchases: () => purchases,
		setInvoice: (patch: Partial<Stripe.Invoice>) => {
			invoice = { ...invoice, ...patch }
		},
		add: (p: EarlyPurchase) => purchases.push(p),
	}
}

describe('early access metadata and lifecycle', () => {
	it('dry-run grant bypasses an unavailable lock and performs no writes', async () => {
		const f = fixture()
		f.ports.lock = vi.fn(async () => {
			throw new Error('lock unavailable')
		})
		expect((await grantEarlyAccess(f.ports, 'in_test')).state).toBe('ready')
		expect(f.ports.lock).not.toHaveBeenCalled()
		expect(f.ports.mark).not.toHaveBeenCalled()
		expect(f.ports.create).not.toHaveBeenCalled()
		expect(f.ports.notify).not.toHaveBeenCalled()
		await expect(grantEarlyAccess(f.ports, 'in_test', true)).rejects.toThrow(
			'lock unavailable',
		)
	})
	it('dry-run revoke bypasses an unavailable lock and performs no writes', async () => {
		const f = fixture()
		await grantEarlyAccess(f.ports, 'in_test', true)
		vi.mocked(f.ports.mark).mockClear()
		vi.mocked(f.ports.create).mockClear()
		vi.mocked(f.ports.notify).mockClear()
		f.ports.lock = vi.fn(async () => {
			throw new Error('lock unavailable')
		})
		expect((await revokeEarlyAccess(f.ports, 'in_test')).state).toBe(
			'revoke_ready',
		)
		expect(f.ports.lock).not.toHaveBeenCalled()
		expect(f.ports.revoke).not.toHaveBeenCalled()
		expect(f.ports.mark).not.toHaveBeenCalled()
		expect(f.ports.create).not.toHaveBeenCalled()
		expect(f.ports.notify).not.toHaveBeenCalled()
		await expect(revokeEarlyAccess(f.ports, 'in_test', true)).rejects.toThrow(
			'lock unavailable',
		)
	})
	it('refuses preflight failures even on dry run, before the manual marker', async () => {
		const f = fixture()
		f.ports.preflight = vi.fn(async () => {
			throw new Error('Invoice product or merchant account is not configured')
		})
		await expect(grantEarlyAccess(f.ports, 'in_test')).rejects.toThrow(
			'not configured',
		)
		await expect(grantEarlyAccess(f.ports, 'in_test', true)).rejects.toThrow(
			'not configured',
		)
		expect(f.ports.mark).not.toHaveBeenCalled()
		expect(f.ports.create).not.toHaveBeenCalled()
	})
	it('refuses invoices without an active customer before the marker', async () => {
		const f = fixture()
		f.setInvoice({ customer: null })
		await expect(grantEarlyAccess(f.ports, 'in_test', true)).rejects.toThrow(
			'no active customer',
		)
		expect(f.ports.mark).not.toHaveBeenCalled()
	})
	it('uses the current expanded customer email, like the paid handler', () => {
		const f = fixture()
		f.setInvoice({
			customer: {
				id: 'cus_test',
				email: 'current@example.test',
			} as Stripe.Customer,
		})
		expect(invoiceCustomerEmail(f.invoice())).toBe('current@example.test')
	})
	it('dry runs without Stripe or purchase mutations and masks email', async () => {
		const f = fixture()
		const result = await grantEarlyAccess(f.ports, 'in_test')
		expect(result.state).toBe('ready')
		expect(JSON.stringify(result)).not.toContain('learner@')
		expect(f.ports.mark).not.toHaveBeenCalled()
		expect(f.ports.create).not.toHaveBeenCalled()
	})
	it('marks manual before purchase, records id and returns one purchase on replay', async () => {
		const f = fixture()
		const create = f.ports.create
		f.ports.create = vi.fn(async (...args) => {
			expect(f.invoice().metadata?.accessProvisioning).toBe(EARLY_ACCESS)
			return create(...args)
		})
		expect((await grantEarlyAccess(f.ports, 'in_test', true)).state).toBe(
			'granted',
		)
		expect((await grantEarlyAccess(f.ports, 'in_test', true)).state).toBe(
			'already_granted',
		)
		expect(f.ports.create).toHaveBeenCalledTimes(1)
		expect(f.invoice().metadata?.earlyAccessPurchaseId).toBe('early_in_test')
		expect(f.invoice().metadata?.earlyAccessGrantedAt).toMatch(/^20/)
	})
	it.each(['paid', 'void', 'draft', 'uncollectible'] as const)(
		'refuses %s without writes',
		async (status) => {
			const f = fixture()
			f.setInvoice({ status })
			await expect(grantEarlyAccess(f.ports, 'in_test', true)).rejects.toThrow(
				'only an unpaid OPEN',
			)
			expect(f.ports.mark).not.toHaveBeenCalled()
		},
	)
	it('refuses partially paid open invoices and nonautomatic invoices', () => {
		const f = fixture()
		f.setInvoice({ amount_paid: 1 })
		expect(() => assertGrantable(f.invoice())).toThrow('only an unpaid OPEN')
		f.setInvoice({
			amount_paid: 0,
			metadata: { accessProvisioning: 'manual_other' },
		})
		expect(() => assertGrantable(f.invoice())).toThrow('automatic')
	})
	it('refuses existing paid-path purchase even if metadata is automatic', async () => {
		const f = fixture()
		f.add({ id: 'paid', status: 'Valid' })
		await expect(grantEarlyAccess(f.ports, 'in_test', true)).rejects.toThrow(
			'already has a purchase',
		)
	})
	it('resumes marked-but-not-created grants without restoring automatic', async () => {
		const f = fixture()
		f.setInvoice({ metadata: grantMetadata('2026-11-05T00:00:00Z') })
		expect((await grantEarlyAccess(f.ports, 'in_test', true)).state).toBe(
			'granted',
		)
		expect(f.invoice().metadata?.earlyAccessGrantedAt).toBe(
			'2026-11-05T00:00:00Z',
		)
	})
	it('repairs metadata after purchase committed but final Stripe update failed', async () => {
		const f = fixture()
		const mark = f.ports.mark
		let calls = 0
		f.ports.mark = async (...args) => {
			if (++calls === 2) throw new Error('transient')
			return mark(...args)
		}
		await expect(grantEarlyAccess(f.ports, 'in_test', true)).rejects.toThrow(
			'transient',
		)
		expect(f.purchases()).toHaveLength(1)
		expect((await grantEarlyAccess(f.ports, 'in_test')).state).toBe(
			'repair_ready',
		)
		expect((await grantEarlyAccess(f.ports, 'in_test', true)).state).toBe(
			'already_granted',
		)
		expect(f.ports.create).toHaveBeenCalledTimes(1)
		expect(f.invoice().metadata?.earlyAccessPurchaseId).toBe('early_in_test')
	})
	it('does not create if payment happens during metadata marking', async () => {
		const f = fixture()
		const mark = f.ports.mark
		f.ports.mark = async (...args) => {
			await mark(...args)
			f.setInvoice({ status: 'paid', amount_paid: 19900 })
		}
		await expect(grantEarlyAccess(f.ports, 'in_test', true)).rejects.toThrow(
			'Invoice changed',
		)
		expect(f.ports.create).not.toHaveBeenCalled()
	})
	it('surfaces DOUBLE when an already-running payment path writes after marking', async () => {
		const f = fixture()
		const create = f.ports.create
		f.ports.create = async (...args) => {
			const p = await create(...args)
			f.add({ id: 'payment-race', status: 'Valid' })
			f.setInvoice({ status: 'paid', amount_paid: 19900 })
			return p
		}
		await expect(grantEarlyAccess(f.ports, 'in_test', true)).rejects.toThrow(
			'DOUBLE',
		)
		expect(f.ports.notify).not.toHaveBeenCalled()
	})
	it('reports only open past due, void and uncollectible; never paid or future due', () => {
		const f = fixture()
		f.setInvoice({ metadata: grantMetadata('now', 'purchase') })
		expect(needsReview(f.invoice(), 2000)).toBe(true)
		f.setInvoice({ due_date: 3 })
		expect(needsReview(f.invoice(), 2000)).toBe(false)
		for (const status of ['void', 'uncollectible'] as const) {
			f.setInvoice({ status })
			expect(needsReview(f.invoice())).toBe(true)
		}
		f.setInvoice({ status: 'paid' })
		expect(needsReview(f.invoice())).toBe(false)
	})
	it('revoke dry-run leaves access; apply uses cleanup; paid cannot revoke', async () => {
		const f = fixture()
		await grantEarlyAccess(f.ports, 'in_test', true)
		expect((await revokeEarlyAccess(f.ports, 'in_test')).state).toBe(
			'revoke_ready',
		)
		expect(f.ports.revoke).not.toHaveBeenCalled()
		await revokeEarlyAccess(f.ports, 'in_test', true)
		expect(f.purchases()[0]?.status).toBe('Refunded')
		f.setInvoice({ status: 'paid', amount_paid: 19900 })
		await expect(revokeEarlyAccess(f.ports, 'in_test', true)).rejects.toThrow(
			'normal refund',
		)
	})
})

describe('operator arguments', () => {
	it('defaults grant/revoke to dry-run; report never mutates', () => {
		expect(earlyAccessRequest(['grant', 'in_abc']).apply).toBe(false)
		expect(earlyAccessRequest(['revoke', 'in_abc', '--apply']).apply).toBe(true)
		expect(earlyAccessRequest(['report'])).toEqual({
			command: 'report',
			apply: false,
		})
	})
	it.each([
		['grant', 'bad'],
		['report', '--apply'],
		['grant', 'in_abc', '--wat'],
	])('refuses invalid arguments %s', (...args) => {
		expect(() => earlyAccessRequest(args)).toThrow()
	})
})
