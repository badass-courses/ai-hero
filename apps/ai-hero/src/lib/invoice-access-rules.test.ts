import { describe, expect, it } from 'vitest'

import {
	canViewInvoice,
	invoiceDisplayAmount,
	invoiceListView,
	pickOriginTransfer,
	resolveOriginalPayerUserId,
	type InvoiceTransferFact,
} from './invoice-access-rules'

// Legacy: the page and list only followed the charge owner (billing user).
// A completed transfer reassigns MerchantCharge.userId to the new holder, so
// the original payer fell out of this predicate.
const legacyCanView = ({
	viewerId,
	chargeUserId,
}: {
	viewerId: string
	chargeUserId: string
}) => viewerId === chargeUserId

// Legacy amount: the charge currency and settlement amount only.
const legacyDisplay = (facts: {
	amount: number
	currency: string
	amount_refunded: number
}) => ({
	currency: facts.currency.toUpperCase(),
	amount: facts.amount - facts.amount_refunded,
})

// Legacy list: heading counted every purchase, including those with no charge.
const legacyHeading = (rows: { merchantChargeId?: string | null }[]) =>
	rows.length > 0 ? 'Your Invoices' : 'No invoices'

const completed = (sourceUserId: string): InvoiceTransferFact => ({
	state: 'COMPLETED',
	sourceUserId,
})

type Role = 'payer' | 'owner' | 'previous' | 'unrelated'

/**
 * Every account in a purchase's life. After a transfer chain
 * payer -> previous -> owner the charge belongs to the current owner.
 */
function scenario(kind: 'untransferred' | 'moved' | 'chain') {
	const ids = { payer: 'u-payer', owner: 'u-owner', previous: 'u-prev' }
	if (kind === 'untransferred') {
		return {
			purchaseUserId: ids.payer,
			chargeUserId: ids.payer,
			transfers: [] as InvoiceTransferFact[],
			ids,
			expected: { payer: true, owner: true, previous: false, unrelated: false },
			// In this shape the payer and the owner are the same account.
			sameAccount: true,
		}
	}
	if (kind === 'moved') {
		return {
			purchaseUserId: ids.owner,
			chargeUserId: ids.owner,
			transfers: [completed(ids.payer)],
			ids,
			expected: { payer: true, owner: true, previous: false, unrelated: false },
			sameAccount: false,
		}
	}
	return {
		purchaseUserId: ids.owner,
		chargeUserId: ids.owner,
		transfers: [
			{ ...completed(ids.payer), completedAt: new Date('2026-01-01') },
			{ ...completed(ids.previous), completedAt: new Date('2026-02-01') },
		],
		ids,
		expected: { payer: true, owner: true, previous: false, unrelated: false },
		sameAccount: false,
	}
}

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

	it('legacy predicate loses the original payer after a transfer', () => {
		// Charge reassigned to the new holder 'a'.
		expect(legacyCanView({ viewerId: 'p', chargeUserId: 'a' })).toBe(false)
		expect(
			canViewInvoice({
				viewerId: 'p',
				purchaseUserId: 'a',
				payerUserId: resolveOriginalPayerUserId('a', [completed('p')]),
				transfer: pickOriginTransfer([completed('p')]),
			}),
		).toBe(true)
	})
})

describe('negative control: generated roles', () => {
	for (const kind of ['untransferred', 'moved', 'chain'] as const) {
		const s = scenario(kind)
		const roles: Role[] = ['payer', 'owner', 'previous', 'unrelated']
		for (const role of roles) {
			const viewerId = role === 'unrelated' ? 'u-unrelated' : s.ids[role]
			it(`${kind}: ${role} ${s.expected[role] ? 'sees' : 'cannot see'} the invoice`, () => {
				const transfer = pickOriginTransfer(s.transfers)
				const result = canViewInvoice({
					viewerId,
					purchaseUserId: s.purchaseUserId,
					payerUserId: resolveOriginalPayerUserId(s.chargeUserId, s.transfers),
					transfer,
				})
				// untransferred: the payer account is also the holder; the owner
				// role is a distinct account that never touched the purchase.
				const expected =
					kind === 'untransferred' && role === 'owner'
						? false
						: s.expected[role]
				expect(result).toBe(expected)
			})
		}
	}

	it('only payer and current owner ever pass, across generated viewers', () => {
		for (const kind of ['moved', 'chain'] as const) {
			const s = scenario(kind)
			const viewers = ['u-payer', 'u-owner', 'u-prev', 'u-x', 'u-y', '']
			const allowed = viewers.filter((viewerId) =>
				canViewInvoice({
					viewerId,
					purchaseUserId: s.purchaseUserId,
					payerUserId: resolveOriginalPayerUserId(s.chargeUserId, s.transfers),
					transfer: pickOriginTransfer(s.transfers),
				}),
			)
			expect(allowed).toEqual(['u-payer', 'u-owner'])
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
	it('picks the earliest completed hop regardless of order', () => {
		const later = { ...completed('b'), completedAt: new Date('2026-03-01') }
		const first = { ...completed('a'), completedAt: new Date('2026-01-01') }
		expect(pickOriginTransfer([later, first])).toBe(first)
		expect(pickOriginTransfer([first, later])).toBe(first)
	})
	it('falls back to the charge owner when nothing completed', () => {
		expect(resolveOriginalPayerUserId('c', [])).toBe('c')
		expect(resolveOriginalPayerUserId(null, [])).toBeNull()
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

	it('legacy display shows only settlement USD for a local-currency charge', () => {
		const facts = {
			...base,
			presentment_details: {
				presentment_amount: 30000,
				presentment_currency: 'cad',
			},
		}
		expect(legacyDisplay(facts)).toEqual({ currency: 'USD', amount: 19900 })
		expect(invoiceDisplayAmount(facts).primary.currency).toBe('CAD')
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
		expect(view.emptyMessage).toContain('nothing to invoice')
		expect(legacyHeading([comp, missing])).toBe('Your Invoices')
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
	it('only refunded rows still list', () => {
		const view = invoiceListView([refunded])
		expect(view.heading).toBe('Your Invoices')
		expect(view.entries[0]?.refunded).toBe(true)
	})
})
