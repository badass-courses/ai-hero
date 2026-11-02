import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	auth: vi.fn(),
	merchantCharge: vi.fn(),
	purchase: vi.fn(),
	product: vi.fn(),
	charge: vi.fn(),
	checkoutSession: vi.fn(),
	coupon: vi.fn(),
	merchantSession: vi.fn(),
	originTransfers: vi.fn(),
	samePersonRows: vi.fn(),
	customerQuery: vi.fn(),
	transfers: vi.fn(),
	cookie: vi.fn(),
	readOnlyProps: vi.fn(),
}))

vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.auth }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getMerchantCharge: mocks.merchantCharge,
		getPurchaseForStripeCharge: mocks.purchase,
		getProduct: mocks.product,
	},
	db: {
		select: () => ({ from: () => ({ where: mocks.samePersonRows }) }),
		query: {
			coupon: { findFirst: mocks.coupon },
			merchantSession: { findFirst: mocks.merchantSession },
			purchaseUserTransfer: { findMany: mocks.originTransfers },
			// Never expected: invoices must not follow the shared Stripe customer.
			merchantCustomer: {
				findMany: mocks.customerQuery,
				findFirst: mocks.customerQuery,
			},
		},
	},
}))
vi.mock('stripe', () => ({
	default: class {
		charges = { retrieve: mocks.charge }
		checkout = { sessions: { retrieve: mocks.checkoutSession } }
	},
}))
vi.mock('next/headers', () => ({
	headers: vi.fn(async () => new Headers()),
	cookies: async () => ({ get: mocks.cookie }),
}))
vi.mock('./_components/invoice-details-editor', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('./_components/invoice-details-editor')
		>()
	return {
		...actual,
		InvoiceDetailsReadOnly: (
			props: React.ComponentProps<typeof actual.InvoiceDetailsReadOnly>,
		) => {
			mocks.readOnlyProps(props)
			return <actual.InvoiceDetailsReadOnly {...props} />
		},
	}
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
	redirect: (path: string) => {
		throw new Error(`redirect:${path}`)
	},
}))
vi.mock('next/link', () => ({
	default: ({
		href,
		children,
	}: {
		href: string
		children: React.ReactNode
	}) => <a href={href}>{children}</a>,
}))
vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/brand/logo', () => ({ Logo: () => <span>Logo</span> }))
vi.mock('@coursebuilder/ui', () => ({
	Button: ({
		children,
		asChild,
		...props
	}: React.ComponentProps<'button'> & {
		asChild?: boolean
		variant?: string
	}) => (asChild ? <>{children}</> : <button {...props}>{children}</button>),
	Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
	Label: (props: React.ComponentProps<'label'>) => <label {...props} />,
	Textarea: (props: React.ComponentProps<'textarea'>) => (
		<textarea {...props} />
	),
}))
vi.mock('@coursebuilder/commerce-next/invoices/invoice-print-button', () => ({
	InvoicePrintButton: () => <button>Print</button>,
}))
vi.mock('@/purchase-transfer/purchase-transfer-actions', () => ({
	getPurchaseTransferForPurchaseId: mocks.transfers,
	cancelPurchaseTransfer: vi.fn(),
	initiatePurchaseTransfer: vi.fn(),
}))
vi.mock('@coursebuilder/commerce-next/post-purchase/purchase-transfer', () => ({
	Root: ({ purchaseUserTransfers }: { purchaseUserTransfers: unknown }) => (
		<div>{JSON.stringify(purchaseUserTransfers)}</div>
	),
	Available: () => null,
	Description: () => null,
	Form: () => null,
	InputLabel: () => null,
	InputEmail: () => null,
	SubmitButton: () => null,
	Initiated: () => null,
	Cancel: () => null,
	Completed: () => null,
}))

import {
	drizzleInvoiceSettingsDataSource,
	type InvoiceSettings,
} from '@/lib/invoice-settings'
import { drizzleTeamPurchaseDataSource } from '@/lib/team-purchases'
import { purchaseSchema } from '@coursebuilder/core/schemas'
import * as invoicePage from './page'
import Invoice from './page'
import { createInvoiceLinkToken } from '@/lib/invoice-link-token'
import { drizzleInvoiceLinkDataSource } from '@/lib/invoice-links'

const CHARGE = 'mc_00000000-0000-4000-8000-000000000001'
const savedSettings: InvoiceSettings = {
	purchaseId: 'purchase-synthetic',
	merchantChargeId: CHARGE,
	recipientName: 'Synthetic Recipient',
	companyName: 'Example Company',
	address: '1 Example Street',
	taxId: 'SYNTHETIC-TAX',
	notes: 'Synthetic PO',
	source: 'support',
	updatedByUserId: 'private-user-attribution',
	supportOperatorId: 'private-support-attribution',
}

const SECRET = 'synthetic-invoice-secret-with-at-least-32-bytes'
function tokenFor(chargeId = CHARGE) {
	return createInvoiceLinkToken({ chargeId, linkVersion: 1, secret: SECRET })
}
async function renderInvoice(token: string | undefined = tokenFor()) {
	mocks.cookie.mockReturnValue(token ? { value: token } : undefined)
	return renderToStaticMarkup(
		await Invoice({ params: Promise.resolve({ merchantChargeId: CHARGE }) }),
	)
}

beforeEach(() => {
	vi.restoreAllMocks()
	vi.resetAllMocks()
	vi.stubEnv('INVOICE_LINK_SECRET', SECRET)
	mocks.originTransfers.mockResolvedValue([])
	mocks.samePersonRows.mockResolvedValue([])
	mocks.cookie.mockReturnValue({ value: tokenFor() })
	vi.spyOn(drizzleInvoiceLinkDataSource, 'loadVersion').mockResolvedValue(1)
	mocks.auth.mockResolvedValue({ session: null })
	mocks.merchantCharge.mockResolvedValue({
		identifier: 'ch_synthetic',
		userId: 'payer',
	})
	mocks.charge.mockResolvedValue({
		status: 'succeeded',
		created: 1787184000,
		amount: 19900,
		amount_refunded: 0,
		refunded: false,
		currency: 'usd',
		billing_details: { name: 'Billing Name', email: 'billing@example.invalid' },
		customer: {
			email: 'private-account@example.invalid',
			metadata: { private: 'private-customer-metadata' },
		},
	})
	mocks.purchase.mockResolvedValue({
		id: 'purchase-synthetic',
		userId: 'payer',
		productId: 'product-synthetic',
	})
	mocks.product.mockResolvedValue({ name: 'Synthetic Course' })
	mocks.transfers.mockResolvedValue([
		{ recipient: 'private-transfer@example.invalid' },
	])
	vi.spyOn(drizzleInvoiceSettingsDataSource, 'loadSettings').mockResolvedValue(
		savedSettings,
	)
	vi.spyOn(
		drizzleTeamPurchaseDataSource,
		'loadMembershipsForUser',
	).mockResolvedValue([])
	vi.spyOn(
		drizzleTeamPurchaseDataSource,
		'loadBulkPurchasesForOrganizations',
	).mockResolvedValue([])
})

function expectReadOnly(markup: string) {
	expect(markup).toContain('Synthetic Course')
	for (const value of [
		'Synthetic Recipient',
		'Example Company',
		'1 Example Street',
		'SYNTHETIC-TAX',
		'Synthetic PO',
	]) {
		expect(markup).toContain(value)
	}
	expect(markup).toContain('Print')
	expect(markup).not.toContain('Edit invoice details')
	expect(markup).not.toMatch(/<form|<input|<textarea/)
	expect(markup).not.toContain('private-')
	expect(markup).not.toContain(CHARGE)
	expect(markup).not.toContain('Copy share link')
	expect(markup).not.toContain('Rotate link')
	expect(markup).not.toContain('Transfer this purchase')
	expect(markup).not.toContain('Send via email')
	expect(mocks.transfers).not.toHaveBeenCalled()
}

// Client component props become Flight payloads, even when not visible in HTML.
function collectProps(node: React.ReactNode): unknown[] {
	if (Array.isArray(node)) return node.flatMap(collectProps)
	if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return []
	return [node.props, ...collectProps(node.props.children)]
}

describe('invoice currency presentment', () => {
	async function chargeWith(patch: Record<string, unknown>) {
		mocks.charge.mockResolvedValue({ ...(await mocks.charge()), ...patch })
	}

	it('keeps USD markup unchanged, including same-currency presentment', async () => {
		const original = await renderInvoice()
		expect(original).toContain(
			'<span class="mr-3">Total</span><strong class="text-lg">USD $199.00</strong>',
		)
		expect(original).not.toContain('Amount paid')
		expect(original).not.toContain('Amount received')
		expect(original).not.toContain('Line items')
		await chargeWith({
			presentment_details: {
				presentment_amount: 19900,
				presentment_currency: 'usd',
			},
		})
		expect(await renderInvoice()).toBe(original)
	})

	it('shows the net total for a partly refunded USD charge, as before', async () => {
		await chargeWith({ amount_refunded: 5000 })
		const markup = await renderInvoice()
		expect(markup).toContain(
			'<span class="mr-3">Total</span><strong class="text-lg">USD $149.00</strong>',
		)
		expect(markup).toContain('Partial Refund')
		expect(markup).not.toContain('Amount paid')
	})

	const currencyCases = [
		['pkr', 3592761, '35,927.61'],
		['idr', 3592761, '35,927.61'],
		['cop', 3592761, '35,927.61'],
		['inr', 3592761, '35,927.61'],
		['eur', 27806, '278.06'],
		['jpy', 42000, '42,000'],
		['kwd', 12340, '12.340'],
		['huf', 1045, '10.45'],
		['isk', 50000, '500.00'],
		['ugx', 50000, '500.00'],
	] as const

	it.each(currencyCases)(
		'renders %s presentment with one code and Stripe decimals',
		async (currency, amount, formatted) => {
			await chargeWith({
				presentment_details: {
					presentment_amount: amount,
					presentment_currency: currency,
				},
			})
			const markup = await renderInvoice()
			const code = currency.toUpperCase()
			expect(markup).toContain(
				`Amount paid</span><strong class="text-lg">${code} ${formatted}</strong>`,
			)
			expect(markup.match(new RegExp(code, 'g'))).toHaveLength(1)
			expect(markup).not.toMatch(/\b([A-Z]{3})\s+\1\b/)
		},
	)

	it.each(currencyCases)(
		'renders %s charge line items, total and refund with one code per amount',
		async (currency, amount, formatted) => {
			await chargeWith({ currency, amount })
			const code = currency.toUpperCase()
			const markup = await renderInvoice()
			expect(markup).toContain(
				`Total</span><strong class="text-lg">${code} ${formatted}</strong>`,
			)
			expect(markup.split(`${code} ${formatted}`)).toHaveLength(4)
			expect(markup.match(new RegExp(code, 'g'))).toHaveLength(3)
			expect(markup).not.toMatch(/\b([A-Z]{3})\s+\1\b/)

			await chargeWith({ amount_refunded: amount, refunded: true })
			const refunded = await renderInvoice()
			expect(refunded).toContain(`${code} -${formatted}</td>`)
			expect(refunded.match(new RegExp(code, 'g'))).toHaveLength(4)
			expect(refunded).not.toMatch(/\b([A-Z]{3})\s+\1\b/)
		},
	)

	it('formats PKR bulk unit price, line amount, partial refund and net total', async () => {
		await chargeWith({
			currency: 'pkr',
			amount: 3592761,
			amount_refunded: 10000,
		})
		mocks.purchase.mockResolvedValue({
			id: 'purchase-synthetic',
			userId: 'payer',
			productId: 'product-synthetic',
			merchantSessionId: 'session-synthetic',
		})
		mocks.merchantSession.mockResolvedValue({ identifier: 'cs_synthetic' })
		mocks.checkoutSession.mockResolvedValue({
			line_items: { data: [{ quantity: 3 }] },
		})
		const markup = await renderInvoice()
		expect(markup).toContain('PKR 11,975.87</td><td class="pr-5">3</td>')
		expect(markup).toContain('PKR 35,927.61</td>')
		expect(markup).toContain('PKR -100.00</td>')
		expect(markup).toContain('PKR 35,827.61</strong>')
		expect(markup.match(/PKR/g)).toHaveLength(4)
		expect(markup).not.toMatch(/\b([A-Z]{3})\s+\1\b/)
	})

	it('renders CAD paid with the USD amount received', async () => {
		await chargeWith({
			amount: 14500,
			presentment_details: {
				presentment_amount: 19900,
				presentment_currency: 'cad',
			},
		})
		const markup = await renderInvoice()
		expect(markup).toContain(
			'<span class="mr-3">Amount paid</span><strong class="text-lg">CAD 199.00</strong>',
		)
		expect(markup).toContain(
			'<span class="mr-3">Amount received</span><span>USD $145.00</span>',
		)
	})

	it('renders EUR paid with the USD amount received on a signed public invoice', async () => {
		await chargeWith({
			amount: 29900,
			presentment_details: {
				presentment_amount: 27806,
				presentment_currency: 'eur',
			},
		})
		const markup = await renderInvoice()
		expectReadOnly(markup)
		expect(markup).toContain(
			'<span class="mr-3">Amount paid</span><strong class="text-lg">EUR 278.06</strong>',
		)
		expect(markup).toContain(
			'<span class="mr-3">Amount received</span><span>USD $299.00</span>',
		)
		expect(markup).toContain('Line items are shown in USD.')
		expect(markup.match(/USD \$299\.00/g)).toHaveLength(3)
		expect(mocks.charge).toHaveBeenLastCalledWith('ch_synthetic', {
			expand: ['refunds'],
		})
	})

	it('renders zero-decimal JPY without dividing by 100 or adding decimals', async () => {
		await chargeWith({
			presentment_details: {
				presentment_amount: 42000,
				presentment_currency: 'jpy',
			},
		})
		const markup = await renderInvoice()
		expect(markup).toContain('JPY 42,000</strong>')
		expect(markup).not.toContain('JPY 420.00')
		expect(markup).toContain('Amount received</span><span>USD $199.00')
	})

	it('keeps discounted bulk line items in USD without inventing a local unit price', async () => {
		await chargeWith({
			amount: 29900,
			presentment_details: {
				presentment_amount: 27806,
				presentment_currency: 'eur',
			},
		})
		mocks.purchase.mockResolvedValue({
			id: 'purchase-synthetic',
			userId: 'payer',
			productId: 'product-synthetic',
			merchantSessionId: 'session-synthetic',
		})
		mocks.merchantSession.mockResolvedValue({ identifier: 'cs_synthetic' })
		mocks.checkoutSession.mockResolvedValue({
			line_items: { data: [{ quantity: 2 }] },
		})
		const markup = await renderInvoice()
		expect(markup).toContain('Line items are shown in USD.')
		expect(markup).toContain('USD $149.50</td><td class="pr-5">2</td>')
		expect(markup).toContain('EUR 278.06</strong>')
		expect(markup.match(/EUR/g)).toHaveLength(1)
	})

	it.each([5000, 29900])(
		'keeps original local payment and net USD separate after a %i-cent refund',
		async (refunded) => {
			await chargeWith({
				amount: 29900,
				amount_refunded: refunded,
				refunded: refunded === 29900,
				presentment_details: {
					presentment_amount: 27806,
					presentment_currency: 'eur',
				},
			})
			const markup = await renderInvoice()
			expect(markup).toContain('Line items and refunds are shown in USD.')
			expect(markup).toContain('EUR 278.06</strong>')
			expect(markup).toContain(
				`Amount received after refunds</span><span>USD $${refunded === 29900 ? '0.00' : '249.00'}`,
			)
			expect(markup).toContain(
				'Amount paid is the original payment before refunds.',
			)
		},
	)

	it('ignores incomplete presentment details without breaking the invoice', async () => {
		const original = await renderInvoice()
		await chargeWith({ presentment_details: { presentment_currency: 'eur' } })
		expect(await renderInvoice()).toBe(original)
	})
})

describe('signed shareable invoice', () => {
	it('redirects an anonymous bare link', async () => {
		await expect(renderInvoice('')).rejects.toThrow('redirect:/invoices')
	})
	it.each(['garbage', '1.1.A', '2.1800000000.A'])(
		'redirects an invalid token (%s)',
		async (token) => {
			await expect(renderInvoice(token)).rejects.toThrow('redirect:/invoices')
		},
	)
	it('rejects an expired but correctly signed cookie', async () => {
		const expired = createInvoiceLinkToken({
			chargeId: CHARGE,
			linkVersion: 1,
			secret: SECRET,
			nowSeconds: Math.floor(Date.now() / 1000) - 30 * 86400,
		})
		await expect(renderInvoice(expired)).rejects.toThrow('redirect:/invoices')
	})
	it('rejects a token for another invoice', async () => {
		await expect(renderInvoice(tokenFor('mc_another'))).rejects.toThrow(
			'redirect:/invoices',
		)
	})
	it('rejects an old token after revocation', async () => {
		vi.mocked(drizzleInvoiceLinkDataSource.loadVersion).mockResolvedValue(2)
		await expect(renderInvoice()).rejects.toThrow('redirect:/invoices')
	})
	it('fails closed without the secret', async () => {
		vi.stubEnv('INVOICE_LINK_SECRET', '')
		await expect(renderInvoice()).rejects.toThrow('redirect:/invoices')
	})
	it('refuses a 31-byte secret before reading the link version', async () => {
		vi.stubEnv('INVOICE_LINK_SECRET', 's'.repeat(31))
		await expect(renderInvoice()).rejects.toThrow('redirect:/invoices')
		expect(drizzleInvoiceLinkDataSource.loadVersion).not.toHaveBeenCalled()
	})
	it('keeps the payer editor when the secret is missing and token is invalid', async () => {
		vi.stubEnv('INVOICE_LINK_SECRET', '')
		mocks.auth.mockResolvedValue({ session: { user: { id: 'payer' } } })
		expect(await renderInvoice('garbage')).toContain('Edit invoice details')
	})

	describe('real transfer shapes', () => {
		const as = (id: string) =>
			mocks.auth.mockResolvedValue({ session: { user: { id } } })
		const setShape = (chargeUserId: string, transfers: unknown[]) => {
			vi.stubEnv('INVOICE_LINK_SECRET', '')
			mocks.merchantCharge.mockResolvedValue({
				identifier: 'ch_synthetic',
				userId: chargeUserId,
			})
			mocks.purchase.mockResolvedValue({
				id: 'purchase-synthetic',
				userId: 'holder',
				productId: 'product-synthetic',
			})
			mocks.originTransfers.mockResolvedValue(transfers)
		}
		const canSee = async (id: string) => {
			as(id)
			try {
				return await renderInvoice(undefined)
			} catch (error) {
				if ((error as Error).message === 'redirect:/invoices') return null
				throw error
			}
		}
		const done = (sourceUserId: string, month: number) => ({
			transferState: 'COMPLETED',
			sourceUserId,
			completedAt: new Date(Date.UTC(2026, month, 1)),
			createdAt: new Date(Date.UTC(2026, month, 1)),
		})

		describe('self-service: charge and purchase moved to the holder', () => {
			beforeEach(() => {
				setShape('holder', [done('middle-holder', 2), done('original-payer', 1)])
			})
			it('the original payer sees it and edits', async () => {
				const markup = await canSee('original-payer')
				expect(markup).toContain('Synthetic Course')
				expect(markup).toContain('Edit invoice details')
			})
			// The charge was rewritten to the holder before this fix. The payer
			// is still the origin transfer's source, so the holder views only.
			it('the holder sees it, view only', async () => {
				const markup = await canSee('holder')
				expect(markup).toContain('Synthetic Course')
				expect(markup).not.toContain('Edit invoice details')
			})
			it('a middle holder who never paid is turned away', async () => {
				expect(await canSee('middle-holder')).toBeNull()
			})
			it('an unrelated user is turned away', async () => {
				expect(await canSee('unrelated')).toBeNull()
			})
			it('a user who only matches the shared Stripe customer is turned away', async () => {
				mocks.customerQuery.mockResolvedValue({ userId: 'customer-user' })
				expect(await canSee('customer-user')).toBeNull()
				expect(mocks.customerQuery).not.toHaveBeenCalled()
			})
		})

		describe('redeemed team seat', () => {
			it('a seat holder on a bulk charge is turned away', async () => {
				setShape('buyer', [])
				mocks.purchase.mockResolvedValue({
					id: 'purchase-seat',
					userId: 'holder',
					productId: 'product-synthetic',
					redeemedBulkCouponId: 'coupon-bulk',
				})
				expect(await canSee('holder')).toBeNull()
				expect(await canSee('buyer')).toBeNull()
			})
		})

		describe('support-complete move: purchase moved, charge stayed with the payer', () => {
			beforeEach(() => {
				setShape('original-payer', [])
			})
			it('the payer sees it and edits', async () => {
				const markup = await canSee('original-payer')
				expect(markup).toContain('Synthetic Course')
				expect(markup).toContain('Edit invoice details')
			})
			it('the holder sees it, view only', async () => {
				const markup = await canSee('holder')
				expect(markup).toContain('Synthetic Course')
				expect(markup).not.toContain('Edit invoice details')
			})
			it('an unrelated user is turned away', async () => {
				expect(await canSee('unrelated')).toBeNull()
			})
		})
	})

	it('renders a read-only invoice and print button for an anonymous visitor without transfer data', async () => {
		expectReadOnly(await renderInvoice())
	})

	it('renders the same read-only paper for an unrelated signed-in viewer', async () => {
		mocks.auth.mockResolvedValue({ session: { user: { id: 'other' } } })
		expectReadOnly(await renderInvoice())
	})

	it('does not mistake an anonymous visitor for a missing purchase owner', async () => {
		mocks.merchantCharge.mockResolvedValue({ identifier: 'ch_synthetic' })
		mocks.purchase.mockResolvedValue({
			id: 'purchase-synthetic',
			productId: 'product-synthetic',
		})
		expectReadOnly(await renderInvoice())
	})

	it('keeps account, settings attribution and transfer data out of public client props', async () => {
		const tree = await Invoice({
			params: Promise.resolve({ merchantChargeId: CHARGE }),
		})
		renderToStaticMarkup(tree)
		expect(mocks.readOnlyProps).toHaveBeenCalledOnce()
		const props = mocks.readOnlyProps.mock.calls[0]?.[0]
		expect(Object.keys(props.initialSettings).sort()).toEqual(
			['recipientName', 'companyName', 'address', 'taxId', 'notes'].sort(),
		)
		expect(JSON.stringify([...collectProps(tree), props])).not.toContain(
			'private-',
		)
	})

	it('falls back to the charge billing recipient on the read-only paper', async () => {
		vi.mocked(drizzleInvoiceSettingsDataSource.loadSettings).mockResolvedValue(
			null,
		)
		const markup = await renderInvoice()
		expect(markup).toContain('Billing Name\nbilling@example.invalid')
		expect(markup).not.toMatch(/<form|<input|<textarea/)
	})

	it('keeps a transferred learner with a valid token strictly read-only', async () => {
		mocks.auth.mockResolvedValue({ session: { user: { id: 'learner' } } })
		mocks.purchase.mockResolvedValue({
			id: 'purchase-synthetic',
			userId: 'learner',
			productId: 'product-synthetic',
		})
		const markup = await renderInvoice()
		// The editor and share controls stay hidden; the holder may still pass
		// the purchase on, so transfers are loaded for the holder.
		expect(markup).not.toContain('Edit invoice details')
		expect(markup).not.toMatch(/<form|<input|<textarea/)
		expect(markup).not.toContain('Copy share link')
		expect(markup).not.toContain('Rotate link')
		expect(mocks.transfers).toHaveBeenCalledWith({ id: 'purchase-synthetic' })
	})
	it('retains the editor and owner-only transfers for the payer', async () => {
		mocks.auth.mockResolvedValue({ session: { user: { id: 'payer' } } })
		const markup = await renderInvoice()
		expect(markup).toContain('Edit invoice details')
		expect(markup).toContain('Save details')
		expect(markup).toContain('Synthetic Recipient')
		expect(markup).toContain('private-transfer@example.invalid')
		expect(mocks.transfers).toHaveBeenCalledWith({ id: 'purchase-synthetic' })
	})

	it('keeps the billing payer editor but not learner transfers after a purchase transfer', async () => {
		mocks.auth.mockResolvedValue({ session: { user: { id: 'payer' } } })
		mocks.purchase.mockResolvedValue({
			id: 'purchase-synthetic',
			userId: 'learner',
			productId: 'product-synthetic',
		})
		const markup = await renderInvoice()
		expect(markup).toContain('Edit invoice details')
		expect(mocks.transfers).not.toHaveBeenCalled()
	})

	it('retains the team manager editor without exposing purchase-owner transfers', async () => {
		mocks.auth.mockResolvedValue({ session: { user: { id: 'manager' } } })
		vi.mocked(
			drizzleTeamPurchaseDataSource.loadMembershipsForUser,
		).mockResolvedValue([
			{
				organizationId: 'org-synthetic',
				organizationMembershipRoles: [
					{
						active: true,
						deletedAt: null,
						role: { active: true, deletedAt: null, name: 'billing_admin' },
					},
				],
			},
		])
		vi.mocked(
			drizzleTeamPurchaseDataSource.loadBulkPurchasesForOrganizations,
		).mockResolvedValue([
			purchaseSchema.parse({
				id: 'purchase-synthetic',
				organizationId: 'org-synthetic',
				bulkCouponId: 'bulk-synthetic',
				createdAt: new Date('2026-08-20'),
				totalAmount: 199,
				productId: 'product-synthetic',
			}),
		])
		const markup = await renderInvoice()
		expect(markup).toContain('Edit invoice details')
		expect(markup).toContain('Save details')
		expect(markup).not.toContain('private-')
		expect(mocks.transfers).not.toHaveBeenCalled()
	})

	it.each(['failed', 'pending'])(
		'redirects for a %s provider charge',
		async (status) => {
			mocks.charge.mockResolvedValue({ ...(await mocks.charge()), status })
			await expect(renderInvoice()).rejects.toThrow('redirect:/invoices')
			expect(mocks.auth).not.toHaveBeenCalled()
			expect(
				drizzleInvoiceSettingsDataSource.loadSettings,
			).not.toHaveBeenCalled()
		},
	)

	it('redirects for an unknown charge without loading settings or account extras', async () => {
		mocks.merchantCharge.mockResolvedValue(null)
		await expect(renderInvoice()).rejects.toThrow('redirect:/invoices')
		expect(mocks.charge).not.toHaveBeenCalled()
		expect(mocks.auth).not.toHaveBeenCalled()
		expect(drizzleInvoiceSettingsDataSource.loadSettings).not.toHaveBeenCalled()
		expect(mocks.transfers).not.toHaveBeenCalled()
	})

	it('redirects when charge lookup cannot resolve a product and purchase', async () => {
		mocks.product.mockResolvedValue(null)
		await expect(renderInvoice()).rejects.toThrow('redirect:/invoices')
		expect(mocks.auth).not.toHaveBeenCalled()
	})

	it('marks the invoice page noindex', () => {
		expect(invoicePage).toHaveProperty('metadata.robots.index', false)
	})
})
