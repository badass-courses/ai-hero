import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getServerAuthSession: vi.fn(),
	findCharges: vi.fn(),
	findPurchases: vi.fn(),
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			merchantCharge: { findMany: mocks.findCharges },
			purchases: { findMany: mocks.findPurchases },
		},
	},
}))
vi.mock('next/navigation', () => ({
	redirect: (path: string) => {
		throw new Error(`redirect:${path}`)
	},
}))
vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

// The @coursebuilder packages ship raw .tsx the node loader cannot import in
// tests. The card and button internals are not under test; the page's own
// edit action (passed as InvoiceCard children) is.
vi.mock('@coursebuilder/ui', () => ({
	Button: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@coursebuilder/commerce-next/invoices/invoice-card', () => ({
	InvoiceCard: ({
		children,
		purchase,
	}: {
		children?: React.ReactNode
		purchase: { merchantChargeId: string }
	}) => (
		<div data-slot="invoice-card">
			<a href={`/invoices/${purchase.merchantChargeId}`}>View</a>
			{children}
		</div>
	),
}))
vi.mock('next/link', () => ({
	default: ({
		href,
		children,
		...rest
	}: {
		href: unknown
		children?: React.ReactNode
	}) => (
		<a href={String(href)} {...rest}>
			{children}
		</a>
	),
}))
vi.mock('next/link.js', () => ({
	default: ({
		href,
		children,
		...rest
	}: {
		href: unknown
		children?: React.ReactNode
	}) => (
		<a href={String(href)} {...rest}>
			{children}
		</a>
	),
}))

import Invoices from './page'

beforeEach(() => {
	vi.resetAllMocks()
	mocks.getServerAuthSession.mockResolvedValue({
		session: { user: { id: 'user_1' } },
	})
	mocks.findCharges.mockResolvedValue([{ id: 'mch_123' }])
	mocks.findPurchases.mockResolvedValue([
		{
			id: 'purchase_1',
			merchantChargeId: 'mch_123',
			totalAmount: 199,
			createdAt: new Date('2026-08-20'),
			productId: 'product_1',
			product: {
				id: 'product_1',
				name: 'AI Coding Crash Course',
				fields: { slug: 'synthetic-course' },
				createdAt: null,
			},
		},
		// No merchant charge, so no invoice or edit action.
		{
			id: 'purchase_2',
			merchantChargeId: null,
			totalAmount: 0,
			createdAt: new Date('2026-08-21'),
			productId: 'product_2',
			product: {
				id: 'product_2',
				name: 'Free thing',
				fields: { slug: 'synthetic-free' },
				createdAt: null,
			},
		},
	])
})

describe('invoices list', () => {
	it('redirects an anonymous visitor to sign in without querying personal invoices', async () => {
		mocks.getServerAuthSession.mockResolvedValue({ session: null })
		await expect(Invoices()).rejects.toThrow('redirect:/login')
		expect(mocks.findCharges).not.toHaveBeenCalled()
		expect(mocks.findPurchases).not.toHaveBeenCalled()
	})
	it('shows an obvious Edit invoice details action for each invoice', async () => {
		const markup = renderToStaticMarkup(await Invoices())
		const editActions = markup.match(/Edit invoice details/g) ?? []
		expect(editActions).toHaveLength(1)
		expect(markup).toContain('/invoices/mch_123#invoice-details')
	})
})
