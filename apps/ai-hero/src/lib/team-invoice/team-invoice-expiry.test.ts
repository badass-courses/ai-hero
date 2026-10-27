import { describe, expect, it, vi } from 'vitest'

import type { TeamInvoiceProduct } from './create-team-invoice'
import {
	teamInvoiceExpiry,
	voidExpiredTeamInvoices,
	type OpenTeamInvoice,
} from './team-invoice-expiry'

const NOW = new Date('2026-10-10T12:00:00.000Z')

const cohort = (
	fields: Record<string, string>,
	over: Partial<TeamInvoiceProduct> = {},
): TeamInvoiceProduct => ({
	product: {
		id: 'product-cohort',
		type: 'cohort',
		status: 1,
		quantityAvailable: -1,
		fields: { state: 'published', ...fields },
	},
	purchaseCount: 0,
	heldSeats: 0,
	stripePriceId: 'price_1',
	stripeProductId: 'prod_1',
	listUnitAmount: 10_000,
	...over,
})

const invoice: OpenTeamInvoice = {
	id: 'in_open',
	productId: 'product-cohort',
	seats: 5,
}

describe('teamInvoiceExpiry', () => {
	it('keeps an invoice whose product still sells its seats', () => {
		expect(
			teamInvoiceExpiry(
				invoice,
				cohort({ closeEnrollment: '2026-10-20T00:00:00.000Z' }),
				NOW,
			),
		).toEqual({ void: false })
	})

	it('voids once enrollment has closed', () => {
		expect(
			teamInvoiceExpiry(
				invoice,
				cohort({ closeEnrollment: '2026-10-10T00:00:00.000Z' }),
				NOW,
			),
		).toEqual({ void: true, reason: 'closed' })
	})

	it('does not count the invoice against its own hold', () => {
		const limited = (purchaseCount: number) =>
			cohort(
				{},
				{
					product: {
						...cohort({}).product,
						quantityAvailable: 10,
					},
					purchaseCount,
					heldSeats: 5,
				},
			)
		expect(teamInvoiceExpiry(invoice, limited(5), NOW)).toEqual({ void: false })
		expect(teamInvoiceExpiry(invoice, limited(6), NOW)).toEqual({
			void: true,
			reason: 'sold-out',
		})
	})

	it('voids when the product is archived or gone', () => {
		expect(
			teamInvoiceExpiry(
				invoice,
				cohort({}, { product: { ...cohort({}).product, status: 0 } }),
				NOW,
			),
		).toEqual({ void: true, reason: 'archived' })
		expect(teamInvoiceExpiry(invoice, null, NOW)).toEqual({
			void: true,
			reason: 'product-missing',
		})
	})
})

describe('voidExpiredTeamInvoices', () => {
	it('voids and reports only the expired ones, loading each product once', async () => {
		const open: OpenTeamInvoice[] = [
			invoice,
			{ id: 'in_second', productId: 'product-cohort', seats: 2 },
			{ id: 'in_live', productId: 'product-live', seats: 3 },
		]
		const loadProduct = vi.fn(async (id: string) =>
			id === 'product-cohort'
				? cohort({ closeEnrollment: '2026-10-01T00:00:00.000Z' })
				: cohort({}),
		)
		const deps = {
			now: () => NOW,
			openInvoices: vi.fn().mockResolvedValue(open),
			loadProduct,
			voidInvoice: vi.fn().mockResolvedValue(true),
			notify: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
		}
		const result = await voidExpiredTeamInvoices(deps)
		expect(result).toEqual({
			checked: 3,
			voided: [
				{ id: 'in_open', reason: 'closed' },
				{ id: 'in_second', reason: 'closed' },
			],
		})
		expect(loadProduct).toHaveBeenCalledTimes(2)
		expect(deps.notify).toHaveBeenCalledTimes(2)
	})

	it('skips an invoice paid since the search, and keeps going past a failure', async () => {
		const deps = {
			now: () => NOW,
			openInvoices: vi.fn().mockResolvedValue([
				invoice,
				{ ...invoice, id: 'in_broken' },
				{ ...invoice, id: 'in_third' },
			]),
			loadProduct: vi
				.fn()
				.mockResolvedValue(cohort({ closeEnrollment: '2026-10-01T00:00:00.000Z' })),
			voidInvoice: vi
				.fn()
				.mockResolvedValueOnce(false)
				.mockRejectedValueOnce(new Error('stripe down'))
				.mockResolvedValueOnce(true),
			notify: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
		}
		const result = await voidExpiredTeamInvoices(deps)
		expect(result.voided).toEqual([{ id: 'in_third', reason: 'closed' }])
		expect(deps.notify).toHaveBeenCalledTimes(1)
		expect(deps.log).toHaveBeenCalledWith(
			'team_invoice.void_failed',
			expect.objectContaining({ invoiceId: 'in_broken' }),
		)
	})
})
