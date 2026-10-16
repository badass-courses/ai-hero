import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getPurchaseByCheckoutSessionId: vi.fn(),
	getProduct: vi.fn(),
	getPurchaseThanksDetails: vi.fn(),
	getServerAuthSession: vi.fn(),
	getPurchaseTransferForPurchaseId: vi.fn(),
	redirect: vi.fn((to: string) => {
		throw new Error(`NEXT_REDIRECT:${to}`)
	}),
}))

vi.mock('next/headers', () => ({ headers: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
	redirect: mocks.redirect,
	notFound: vi.fn(),
}))
vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.test' },
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getPurchaseByCheckoutSessionId: mocks.getPurchaseByCheckoutSessionId,
		getProduct: mocks.getProduct,
	},
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('./purchase-thanks-details', () => ({
	getPurchaseThanksDetails: mocks.getPurchaseThanksDetails,
}))
vi.mock('@/purchase-transfer/purchase-transfer-actions', () => ({
	cancelPurchaseTransfer: vi.fn(),
	getPurchaseTransferForPurchaseId: mocks.getPurchaseTransferForPurchaseId,
	initiatePurchaseTransfer: vi.fn(),
}))
vi.mock('@/purchase-transfer/transfer-lifecycle', () => ({
	isTransferablePurchase: () => true,
}))
vi.mock('./purchase-status-poller', () => ({
	PurchaseStatusPoller: () => null,
}))
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }))
vi.mock('@coursebuilder/ui', async (importOriginal) => ({
	...(await importOriginal<object>()),
	Button: ({ children }: { children: ReactNode }) => (
		<button>{children}</button>
	),
}))
vi.mock('../../_components/post-purchase-arrival', () => ({
	PostPurchaseArrival: () => <i data-arrival="" />,
}))
vi.mock('../../_components/post-purchase-login-link', () => ({
	PostPurchaseLoginLink: ({ email }: { email: string }) => (
		<p data-login-link="">{email}</p>
	),
}))
vi.mock('../../_components/post-purchase-receipt', () => ({
	PurchaseInviteTeam: () => <p data-invite="">invite link</p>,
	PurchaseInvoiceRow: () => <p data-invoice="">invoice</p>,
	PurchaseTransferRow: () => <p data-transfer="">transfer</p>,
}))

import ThanksPurchasePage from './page'

const BUYER_EMAIL = 'buyer@example.test'

async function render() {
	const suspense = (await ThanksPurchasePage({
		searchParams: Promise.resolve({ session_id: 'cs_test_1', provider: 'x' }),
	})) as ReactElement<{ children: ReactElement }>
	const loaded = suspense.props.children as ReactElement<any>
	const Loaded = loaded.type as (props: unknown) => Promise<ReactElement>
	return renderToStaticMarkup(await Loaded(loaded.props))
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getPurchaseByCheckoutSessionId.mockResolvedValue({
		id: 'purchase-1',
		productId: 'product-1',
	})
	mocks.getProduct.mockResolvedValue({ name: 'Synthetic course', fields: {} })
	mocks.getPurchaseThanksDetails.mockResolvedValue({
		purchase: { id: 'purchase-1', userId: 'owner-1', productId: 'product-1' },
		email: BUYER_EMAIL,
		seatsPurchased: 5,
		purchaseType: 'NEW_BULK_COUPON',
		bulkCouponId: 'coupon-1',
		product: { name: 'Synthetic course', fields: {} },
		stripeProductName: 'Synthetic course',
		redemptionsLeft: true,
	})
	mocks.getPurchaseTransferForPurchaseId.mockResolvedValue([])
})

describe('thanks page viewers', () => {
	it('a signed-in non-owner sees no email, invite or invoice, and nothing runs', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { id: 'other-1', email: 'stranger@example.test' } },
		})
		const html = await render()
		expect(html).toContain('different account')
		expect(html).toContain('st***@example.test')
		for (const leaked of [
			BUYER_EMAIL,
			'data-login-link',
			'data-invite',
			'data-invoice',
			'data-transfer',
			'data-arrival',
			'Synthetic course',
		])
			expect(html).not.toContain(leaked)
		expect(html).toContain('Sign out')
		expect(mocks.getPurchaseTransferForPurchaseId).not.toHaveBeenCalled()
		expect(mocks.redirect).not.toHaveBeenCalled()
	})

	it('a signed-out buyer keeps the receipt', async () => {
		mocks.getServerAuthSession.mockResolvedValue(null)
		const html = await render()
		expect(html).toContain('data-login-link')
		expect(html).toContain('data-invite')
	})

	it('the owner is sent to the welcome page', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { id: 'owner-1', email: BUYER_EMAIL } },
		})
		await expect(render()).rejects.toThrow('NEXT_REDIRECT:/welcome?')
	})
})
