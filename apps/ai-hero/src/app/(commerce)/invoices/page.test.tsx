import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getServerAuthSession: vi.fn(async () => ({
		session: { user: { id: 'user_1' } },
	})),
	getPurchasesForUser: vi.fn(async () => [
		{
			id: 'purchase_1',
			merchantChargeId: 'mch_123',
			totalAmount: 199,
			createdAt: '2026-08-20T00:00:00.000Z',
			product: { name: 'AI Coding Crash Course' },
		},
		{
			// No merchant charge, so no invoice and no edit action.
			id: 'purchase_2',
			merchantChargeId: null,
			totalAmount: 0,
			createdAt: '2026-08-21T00:00:00.000Z',
			product: { name: 'Free thing' },
		},
	]),
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: { getPurchasesForUser: mocks.getPurchasesForUser },
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
vi.mock('@coursebuilder/core/schemas', () => ({}))

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

describe('invoices list', () => {
	it('shows an obvious Edit invoice details action for each invoice', async () => {
		const markup = renderToStaticMarkup(await Invoices())
		const editActions = markup.match(/Edit invoice details/g) ?? []
		expect(editActions).toHaveLength(1)
		expect(markup).toContain('/invoices/mch_123#invoice-details')
	})
})
