import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	discordAccountsForCurrentUser: vi.fn(),
	getServerAuthSession: vi.fn(),
	getPurchaseDetails: vi.fn(),
	getProduct: vi.fn(),
	getProductResources: vi.fn(),
	getPurchaseTransferForPurchaseId: vi.fn(),
}))

vi.mock('next/headers', () => ({ headers: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/coursebuilder/stripe-provider', () => ({ stripeProvider: {} }))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getPurchaseDetails: mocks.getPurchaseDetails,
		getProduct: mocks.getProduct,
		getProductResources: mocks.getProductResources,
	},
	db: {},
}))
vi.mock('@/env.mjs', () => ({ env: { COURSEBUILDER_URL: 'https://example.com' } }))
vi.mock('@/lib/subscriptions', () => ({ getSubscription: vi.fn() }))
vi.mock('@/lib/users', () => ({
	discordAccountsForCurrentUser: mocks.discordAccountsForCurrentUser,
	githubAccountsForCurrentUser: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/purchase-transfer/purchase-transfer-actions', () => ({
	cancelPurchaseTransfer: vi.fn(),
	getPurchaseTransferForPurchaseId: mocks.getPurchaseTransferForPurchaseId,
	initiatePurchaseTransfer: vi.fn(),
}))
vi.mock('@/server/auth', () => ({
	authOptions: {
		providers: [
			{ id: 'postmark', name: 'Email' },
			{ id: 'discord', name: 'Discord' },
			{ id: 'github', name: 'GitHub' },
		],
	},
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock(
	'@coursebuilder/commerce-next/post-purchase/subscription-welcome-page',
	() => ({ SubscriptionWelcomePage: () => null }),
)
vi.mock(
	'@coursebuilder/commerce-next/utils/serialize-for-next-response',
	() => ({ convertToSerializeForNextResponse: (value: unknown) => value }),
)

import Welcome from './page'
import { PostPurchaseDiscordAccess } from './welcome-discord-entry'

async function renderPurchaseWelcome(isDiscordConnected: boolean) {
	mocks.discordAccountsForCurrentUser.mockResolvedValue(isDiscordConnected)

	const page = await Welcome({
		searchParams: Promise.resolve({
			session_id: '',
			provider: '',
			purchaseId: 'purchase-1',
		}),
	})

	return renderToStaticMarkup(page as ReactElement)
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getServerAuthSession.mockResolvedValue({
		session: { user: { id: 'user-1', email: 'learner@example.com' } },
		ability: { can: vi.fn().mockReturnValue(false) },
	})
	mocks.getPurchaseDetails.mockResolvedValue({
		purchase: {
			id: 'purchase-1',
			productId: 'product-1',
			product: { name: 'Synthetic course', type: 'self-paced' },
			bulkCoupon: null,
			merchantChargeId: 'charge-1',
			totalAmount: 199,
			createdAt: new Date('2026-10-14T09:00:00Z'),
		},
		existingPurchase: null,
		availableUpgrades: [],
	})
	mocks.getProduct.mockResolvedValue({ id: 'product-1' })
	mocks.getProductResources.mockResolvedValue([])
	mocks.getPurchaseTransferForPurchaseId.mockResolvedValue([])
})

describe('post-purchase Discord entry', () => {
	it('routes unlinked purchasers through the managed Discord link flow', () => {
		const markup = renderToStaticMarkup(
			<PostPurchaseDiscordAccess isDiscordConnected={false} />,
		)

		expect(markup).toContain('href="/discord"')
		expect(markup).toContain('Join Discord')
		expect(markup).not.toContain('/api/auth/signin/discord')
	})

	it('does not show the link after Discord is connected', () => {
		const markup = renderToStaticMarkup(
			<PostPurchaseDiscordAccess isDiscordConnected />,
		)

		expect(markup).toBe('')
	})

	it('wires unlinked purchasers to managed Discord access on the production page', async () => {
		const markup = await renderPurchaseWelcome(false)

		expect(markup).toContain('href="/discord"')
		expect(markup).toContain('Join Discord')
		expect(markup).not.toContain('signin/discord')
		expect(markup).not.toContain('data-discord-button')
	})

	it('hides managed access when linked and never offers the direct OAuth action', async () => {
		const markup = await renderPurchaseWelcome(true)

		expect(markup).not.toContain('href="/discord"')
		expect(markup).not.toContain('Join Discord')
		expect(markup).not.toContain('signin/discord')
	})

	it('leads with the product and keeps the receipt below it', async () => {
		const markup = await renderPurchaseWelcome(true)

		expect(markup).toContain('Welcome to')
		expect(markup).toContain('Synthetic course')
		expect(markup).toContain('href="/invoices/charge-1"')
		expect(markup).toContain('Share on X')
		expect(markup.match(/<h1/g)).toHaveLength(1)
	})
})
