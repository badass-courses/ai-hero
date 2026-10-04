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
	transfers: vi.fn(),
	cookie: vi.fn(),
	readOnlyProps: vi.fn(),
}))

vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.auth }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn() },
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getMerchantCharge: mocks.merchantCharge,
		getPurchaseForStripeCharge: mocks.purchase,
		getProduct: mocks.product,
	},
	db: {
		query: {
			coupon: { findFirst: mocks.coupon },
			merchantSession: { findFirst: mocks.merchantSession },
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
		expectReadOnly(await renderInvoice())
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
