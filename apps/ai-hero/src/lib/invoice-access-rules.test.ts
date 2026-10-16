import { describe, expect, it } from 'vitest'

import {
	canViewInvoice,
	invoiceDisplayAmount,
	invoiceListView,
	pickOriginTransfer,
	type InvoiceTransferFact,
} from './invoice-access-rules'

const completed = (sourceUserId: string): InvoiceTransferFact => ({
	state: 'COMPLETED',
	sourceUserId,
})

describe('canViewInvoice truth table', () => {
	const cases: {
		name: string
		input: Parameters<typeof canViewInvoice>[0]
		expected: boolean
	}[] = [
		{
			name: 'anonymous viewer',
			input: {
				viewerId: null,
				purchaseUserId: 'a',
				payerUserId: 'a',
				transfer: null,
			},
			expected: false,
		},
		{
			name: 'current holder, no transfer',
			input: {
				viewerId: 'a',
				purchaseUserId: 'a',
				payerUserId: 'x',
				transfer: null,
			},
			expected: true,
		},
		{
			name: 'charge payer, not holder',
			input: {
				viewerId: 'p',
				purchaseUserId: 'a',
				payerUserId: 'p',
				transfer: null,
			},
			expected: true,
		},
		{
			name: 'unrelated, no transfer',
			input: {
				viewerId: 'z',
				purchaseUserId: 'a',
				payerUserId: 'p',
				transfer: null,
			},
			expected: false,
		},
		{
			name: 'original payer after completed transfer',
			input: {
				viewerId: 'p',
				purchaseUserId: 'a',
				payerUserId: 'a',
				transfer: completed('p'),
			},
			expected: true,
		},
		{
			name: 'transfer only initiated: source not granted by it',
			input: {
				viewerId: 'z',
				purchaseUserId: 'a',
				payerUserId: 'p',
				transfer: { state: 'INITIATED', sourceUserId: 'z' },
			},
			expected: false,
		},
		{
			name: 'unrelated with a completed transfer elsewhere',
			input: {
				viewerId: 'z',
				purchaseUserId: 'a',
				payerUserId: 'a',
				transfer: completed('p'),
			},
			expected: false,
		},
		{
			name: 'missing viewer id string',
			input: {
				viewerId: '',
				purchaseUserId: '',
				payerUserId: '',
				transfer: null,
			},
			expected: false,
		},
	]
	it.each(cases)('$name', ({ input, expected }) => {
		expect(canViewInvoice(input)).toBe(expected)
	})
})

// Each row states who may view one purchase. The decision inputs mirror what
// the page and list read: Purchase.userId, MerchantCharge.userId and the
// COMPLETED PurchaseUserTransfer rows for that purchase.
type Shape = {
	name: string
	purchaseUserId: string
	chargeUserId: string
	transfers: InvoiceTransferFact[]
	allowed: string[]
	denied: string[]
}
const at = (month: number) => new Date(Date.UTC(2026, month, 1))
const shapes: Shape[] = [
	{
		name: 'untransferred',
		purchaseUserId: 'payer',
		chargeUserId: 'payer',
		transfers: [],
		allowed: ['payer'],
		denied: ['stranger', 'former-holder'],
	},
	{
		// Self-service: purchase and charge both moved to the holder.
		name: 'self-service transfer',
		purchaseUserId: 'holder',
		chargeUserId: 'holder',
		transfers: [{ ...completed('payer'), completedAt: at(1) }],
		allowed: ['payer', 'holder'],
		denied: ['stranger'],
	},
	{
		// Support-complete: only the purchase moved, the charge stays.
		name: 'support-complete move',
		purchaseUserId: 'holder',
		chargeUserId: 'payer',
		transfers: [],
		allowed: ['payer', 'holder'],
		denied: ['stranger'],
	},
	{
		name: 'self-service chain payer -> middle -> holder',
		purchaseUserId: 'holder',
		chargeUserId: 'holder',
		transfers: [
			{ ...completed('middle'), completedAt: at(2) },
			{ ...completed('payer'), completedAt: at(1) },
		],
		allowed: ['payer', 'holder'],
		denied: ['middle', 'stranger'],
	},
	{
		// One Stripe customer is shared across a buyer's charges. Transferring
		// purchase X moves nothing about untransferred purchase Y, which still
		// belongs to its payer.
		name: 'shared customer: untransferred sibling purchase Y',
		purchaseUserId: 'payer',
		chargeUserId: 'payer',
		transfers: [],
		allowed: ['payer'],
		denied: ['holder-of-sibling-x', 'stranger'],
	},
	{
		name: 'a transfer that never completed grants nothing',
		purchaseUserId: 'payer',
		chargeUserId: 'payer',
		transfers: [{ state: 'INITIATED', sourceUserId: 'payer' }],
		allowed: ['payer'],
		denied: ['stranger', 'target'],
	},
]

describe.each(shapes)('who sees: $name', (shape) => {
	const decide = (viewerId: string) =>
		canViewInvoice({
			viewerId,
			purchaseUserId: shape.purchaseUserId,
			payerUserId: shape.chargeUserId,
			transfer: pickOriginTransfer(shape.transfers),
		})
	it.each(shape.allowed)('%s sees it', (viewer) => {
		expect(decide(viewer)).toBe(true)
	})
	it.each(shape.denied)('%s does not', (viewer) => {
		expect(decide(viewer)).toBe(false)
	})
	it('nobody else among generated viewers sees it', () => {
		for (const viewer of ['v1', 'v2', 'v3', '']) {
			expect(decide(viewer)).toBe(false)
		}
	})
})

describe('pickOriginTransfer', () => {
	it('returns null with no completed transfer', () => {
		expect(pickOriginTransfer([])).toBeNull()
		expect(
			pickOriginTransfer([{ state: 'CANCELED', sourceUserId: 'p' }]),
		).toBeNull()
	})
	it('falls back to createdAt, then id, and names nothing without timestamps', () => {
		const old = { ...completed('a'), createdAt: at(1) }
		const recent = { ...completed('b'), createdAt: at(2) }
		expect(pickOriginTransfer([recent, old])).toBe(old)
		const x = { ...completed('x'), id: 'tr-1', createdAt: at(3) }
		const y = { ...completed('y'), id: 'tr-2', createdAt: at(3) }
		expect(pickOriginTransfer([y, x])).toBe(x)
		expect(pickOriginTransfer([completed('p'), completed('q')])).toBeNull()
	})
	it('picks the earliest completed hop regardless of order', () => {
		const later = { ...completed('b'), completedAt: new Date('2026-03-01') }
		const first = { ...completed('a'), completedAt: new Date('2026-01-01') }
		expect(pickOriginTransfer([later, first])).toBe(first)
		expect(pickOriginTransfer([first, later])).toBe(first)
	})
})

describe('invoiceDisplayAmount truth table', () => {
	const base = { amount: 19900, currency: 'usd', amount_refunded: 0 }
	const cases: {
		name: string
		facts: Parameters<typeof invoiceDisplayAmount>[0]
		expected: ReturnType<typeof invoiceDisplayAmount>
	}[] = [
		{
			name: 'no presentment details: charge as is',
			facts: base,
			expected: {
				primary: { amount: 19900, currency: 'USD' },
				secondary: null,
			},
		},
		{
			name: 'local currency leads, settlement is secondary',
			facts: {
				...base,
				presentment_details: {
					presentment_amount: 30000,
					presentment_currency: 'cad',
				},
			},
			expected: {
				primary: { amount: 30000, currency: 'CAD' },
				secondary: { amount: 19900, currency: 'USD' },
			},
		},
		{
			name: 'refund reduces settlement, not the original paid amount',
			facts: {
				...base,
				amount_refunded: 5000,
				presentment_details: {
					presentment_amount: 30000,
					presentment_currency: 'cad',
				},
			},
			expected: {
				primary: { amount: 30000, currency: 'CAD' },
				secondary: { amount: 14900, currency: 'USD' },
			},
		},
		{
			name: 'same currency presentment is ignored',
			facts: {
				...base,
				presentment_details: {
					presentment_amount: 19900,
					presentment_currency: 'usd',
				},
			},
			expected: {
				primary: { amount: 19900, currency: 'USD' },
				secondary: null,
			},
		},
		{
			name: 'malformed presentment falls back to the charge',
			facts: {
				...base,
				presentment_details: {
					presentment_amount: '300',
					presentment_currency: 'cad',
				},
			},
			expected: {
				primary: { amount: 19900, currency: 'USD' },
				secondary: null,
			},
		},
		{
			name: 'unknown currency code falls back to the charge',
			facts: {
				...base,
				presentment_details: {
					presentment_amount: 300,
					presentment_currency: 'zzz',
				},
			},
			expected: {
				primary: { amount: 19900, currency: 'USD' },
				secondary: null,
			},
		},
		{
			name: 'negative presentment amount falls back',
			facts: {
				...base,
				presentment_details: {
					presentment_amount: -1,
					presentment_currency: 'cad',
				},
			},
			expected: {
				primary: { amount: 19900, currency: 'USD' },
				secondary: null,
			},
		},
		{
			name: 'charge itself settled in a local currency',
			facts: { amount: 2500, currency: 'gbp', amount_refunded: 0 },
			expected: { primary: { amount: 2500, currency: 'GBP' }, secondary: null },
		},
	]
	it.each(cases)('$name', ({ facts, expected }) => {
		expect(invoiceDisplayAmount(facts)).toEqual(expected)
	})
})

describe('invoiceListView truth table', () => {
	const charged = { merchantChargeId: 'mch_1', status: 'Valid' }
	const refunded = { merchantChargeId: 'mch_2', status: 'Refunded' }
	const restricted = { merchantChargeId: 'mch_3', status: 'Restricted' }
	const comp = { merchantChargeId: null, status: 'Valid' }
	const missing = { merchantChargeId: undefined, status: 'Valid' }

	it('empty input', () => {
		expect(invoiceListView([])).toEqual({
			heading: 'No invoices',
			entries: [],
			withoutInvoiceCount: 0,
			emptyMessage: 'You have no invoices yet.',
		})
	})
	it('only comp or redemption rows: honest empty state', () => {
		const view = invoiceListView([comp, missing])
		expect(view.heading).toBe('No invoices')
		expect(view.entries).toHaveLength(0)
		expect(view.withoutInvoiceCount).toBe(2)
		expect(view.emptyMessage).toContain('paid for by someone else')
	})
	it('billed rows list with heading and no empty message', () => {
		const view = invoiceListView([charged, comp])
		expect(view.heading).toBe('Your Invoices')
		expect(view.entries.map((e) => e.merchantChargeId)).toEqual(['mch_1'])
		expect(view.emptyMessage).toBeNull()
		expect(view.withoutInvoiceCount).toBe(1)
	})
	it('labels refunded rows, leaves other states normal', () => {
		const view = invoiceListView([charged, refunded, restricted])
		expect(view.entries.map((e) => [e.merchantChargeId, e.refunded])).toEqual([
			['mch_1', false],
			['mch_2', true],
			['mch_3', false],
		])
	})
	it('view-only rows never get the edit action', () => {
		const view = invoiceListView([
			{ ...charged, canEdit: true },
			{ merchantChargeId: 'mch_9', status: 'Valid', canEdit: false },
			{ merchantChargeId: 'mch_8', status: 'Valid' },
		])
		expect(view.entries.map((e) => e.canEdit)).toEqual([true, false, false])
	})
	it('only refunded rows still list', () => {
		const view = invoiceListView([refunded])
		expect(view.heading).toBe('Your Invoices')
		expect(view.entries[0]?.refunded).toBe(true)
	})
})
