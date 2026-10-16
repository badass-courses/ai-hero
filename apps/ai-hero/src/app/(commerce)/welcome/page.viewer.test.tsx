import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getPurchaseWithUser: vi.fn(),
	getProduct: vi.fn(),
	getProductResources: vi.fn(),
	getPurchaseDetails: vi.fn(),
	getServerAuthSession: vi.fn(),
	redirect: vi.fn((to: string) => {
		throw new Error(`NEXT_REDIRECT:${to}`)
	}),
}))

vi.mock('next/headers', () => ({ headers: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }))
vi.mock('@coursebuilder/ui', () => ({
	Button: ({ children }: { children: ReactNode }) => (
		<button>{children}</button>
	),
}))
vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/db', () => ({
	db: {},
	courseBuilderAdapter: {
		getPurchaseWithUser: mocks.getPurchaseWithUser,
		getProduct: mocks.getProduct,
		getProductResources: mocks.getProductResources,
		getPurchaseDetails: mocks.getPurchaseDetails,
	},
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/coursebuilder/stripe-provider', () => ({ stripeProvider: {} }))
vi.mock('@/lib/subscriptions', () => ({ getSubscription: vi.fn() }))
vi.mock('@/lib/users', () => ({
	discordAccountsForCurrentUser: vi.fn(),
	githubAccountsForCurrentUser: vi.fn(),
}))
vi.mock('@/lib/buy-path/read-context', () => ({
	purchaseBuyPathContext: vi.fn(),
}))
vi.mock('@/purchase-transfer/purchase-transfer-actions', () => ({
	cancelPurchaseTransfer: vi.fn(),
	getPurchaseTransferForPurchaseId: vi.fn(),
	initiatePurchaseTransfer: vi.fn(),
}))
vi.mock('@/purchase-transfer/transfer-lifecycle', () => ({
	isTransferablePurchase: vi.fn(),
}))
vi.mock('@casl/ability', () => ({ subject: vi.fn() }))
vi.mock(
	'@coursebuilder/commerce-next/post-purchase/subscription-welcome-page',
	() => ({
		SubscriptionWelcomePage: () => null,
	}),
)
vi.mock(
	'@coursebuilder/commerce-next/utils/serialize-for-next-response',
	() => ({
		convertToSerializeForNextResponse: (v: unknown) => v,
	}),
)
vi.mock('../_components/post-purchase-shell', () => ({
	PostPurchaseShell: () => null,
}))
vi.mock('../_components/post-purchase-arrival', () => ({
	PostPurchaseArrival: () => null,
}))
vi.mock('../_components/post-purchase-icon', () => ({
	PostPurchaseIconBadge: () => null,
}))
vi.mock('../_components/post-purchase-parts', () => ({
	PURCHASE_PRIMARY_BUTTON: '',
	PurchaseCard: () => null,
	PurchaseCardSection: () => null,
	PurchaseHeading: () => null,
	PurchaseRows: () => null,
}))
vi.mock('../_components/post-purchase-receipt', () => ({
	PurchaseInviteTeam: () => null,
	PurchaseInvoiceRow: () => null,
	PurchaseShareRow: () => null,
	PurchaseTransferRow: () => null,
}))
vi.mock('./welcome-discord-entry', () => ({
	PostPurchaseDiscordAccess: () => null,
}))
vi.mock('./welcome-start', () => ({
	productPagePath: vi.fn(),
	welcomeStart: vi.fn(),
}))
vi.mock('@/components/landing/type', () => ({ TYPE: {} }))
vi.mock('@/lib/purchase-artwork', () => ({ purchaseArtwork: vi.fn() }))

import Welcome from './page'

const render = async () =>
	renderToStaticMarkup(
		(await Welcome({
			searchParams: Promise.resolve({
				purchaseId: 'purchase-1',
				session_id: '',
				provider: 'x',
			}),
		})) as ReactElement,
	)

beforeEach(() => {
	vi.clearAllMocks()
})

describe('welcome page viewers', () => {
	it('a different account sees the message and getPurchaseDetails never runs', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { id: 'other-1', email: 'stranger@example.test' } },
		})
		mocks.getPurchaseWithUser.mockResolvedValue({
			id: 'purchase-1',
			userId: 'owner-1',
			user: { email: 'owner@example.test' },
		})
		const html = await render()
		expect(html).toContain('This purchase belongs to a different account')
		expect(html).toContain('st***@example.test')
		expect(html).not.toContain('stranger@')
		expect(html).toContain('Sign out')
		expect(mocks.getPurchaseDetails).not.toHaveBeenCalled()
		expect(mocks.redirect).not.toHaveBeenCalled()
	})

	it('an unknown purchase still goes home, and details still load for the owner', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { id: 'owner-1', email: 'o@example.test' } },
		})
		mocks.getPurchaseWithUser.mockResolvedValue(null)
		mocks.getPurchaseDetails.mockResolvedValue({ availableUpgrades: [] })
		await expect(render()).rejects.toThrow('NEXT_REDIRECT:/')
	})

	it('matches the owner by purchase email when the ids differ, as thanks does', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { id: 'other-id', email: 'Owner@Example.test' } },
		})
		mocks.getPurchaseWithUser.mockResolvedValue({
			id: 'purchase-1',
			userId: 'owner-1',
			user: { email: 'owner@example.test' },
		})
		mocks.getPurchaseDetails.mockResolvedValue({
			purchase: { id: 'purchase-1', productId: 'p1', product: { name: 'x' } },
			availableUpgrades: [],
		})
		mocks.getProduct.mockResolvedValue({ id: 'p1', name: 'x', fields: {} })
		mocks.getProductResources.mockResolvedValue([])
		const html = await render().catch(() => '')
		expect(html).not.toContain('different account')
		expect(mocks.getPurchaseDetails).toHaveBeenCalledWith(
			'purchase-1',
			'owner-1',
		)
	})
})
