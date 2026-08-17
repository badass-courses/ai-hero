import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	sharedWelcomePage: vi.fn(),
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
vi.mock('@coursebuilder/commerce-next/post-purchase/welcome-page', () => ({
	WelcomePage: (props: unknown) => {
		mocks.sharedWelcomePage(props)
		return null
	},
}))
vi.mock(
	'@coursebuilder/commerce-next/utils/serialize-for-next-response',
	() => ({ convertToSerializeForNextResponse: (value: unknown) => value }),
)

import Welcome from './page'
import {
	PostPurchaseDiscordAccess,
	withoutDiscordProvider,
} from './welcome-discord-entry'

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
			bulkCoupon: null,
			merchantChargeId: 'charge-1',
		},
		existingPurchase: null,
		availableUpgrades: [],
	})
	mocks.getProduct.mockResolvedValue({ id: 'product-1' })
	mocks.getProductResources.mockResolvedValue([])
	mocks.getPurchaseTransferForPurchaseId.mockResolvedValue([])
})

describe('post-purchase Discord entry', () => {
	it('does not expose the direct Discord OAuth action to the shared welcome page', () => {
		const providers = withoutDiscordProvider([
			{ id: 'postmark', name: 'Email' },
			{ id: 'discord', name: 'Discord' },
			{ id: 'github', name: 'GitHub' },
		])

		expect(providers).toEqual([
			{ id: 'postmark', name: 'Email' },
			{ id: 'github', name: 'GitHub' },
		])
	})

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

		expect(mocks.sharedWelcomePage).toHaveBeenCalledWith(
			expect.objectContaining({
				providers: [
					{ id: 'postmark', name: 'Email' },
					{ id: 'github', name: 'GitHub' },
				],
			}),
		)
		expect(markup).toContain('href="/discord"')
		expect(markup).toContain('Join Discord')
	})

	it('keeps Discord out of the shared page and hides managed access when linked', async () => {
		const markup = await renderPurchaseWelcome(true)

		expect(mocks.sharedWelcomePage).toHaveBeenCalledWith(
			expect.objectContaining({
				providers: [
					{ id: 'postmark', name: 'Email' },
					{ id: 'github', name: 'GitHub' },
				],
			}),
		)
		expect(markup).not.toContain('href="/discord"')
		expect(markup).not.toContain('Join Discord')
	})
})
