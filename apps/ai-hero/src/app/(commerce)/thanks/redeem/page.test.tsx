import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getPurchaseWithUser: vi.fn(),
	getProduct: vi.fn(),
	notFound: vi.fn(() => {
		throw new Error('NEXT_NOT_FOUND')
	}),
}))

vi.mock('next/headers', () => ({ headers: vi.fn() }))
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }))
vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.test' },
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getPurchaseWithUser: mocks.getPurchaseWithUser,
		getProduct: mocks.getProduct,
	},
}))

import ThanksRedeem from './page'

const render = async () =>
	renderToStaticMarkup(
		(await ThanksRedeem({
			searchParams: Promise.resolve({ purchaseId: 'purchase-1' }),
		})) as ReactElement,
	)

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getPurchaseWithUser.mockResolvedValue({
		id: 'purchase-1',
		productId: 'product-1',
		user: { id: 'user-1', email: 'teammate@example.test' },
	})
	mocks.getProduct.mockResolvedValue({
		name: 'Synthetic course',
		fields: {},
		resources: [
			{ resource: { fields: { coverImage: { url: 'https://example.test/cover.jpg' } } } },
		],
	})
})

describe('redeemed seat thanks', () => {
	it('shows the course and the login link the teammate has to open', async () => {
		const html = await render()
		expect(html).toContain('Team seat claimed')
		expect(html).toContain('Synthetic course')
		expect(html).toContain('teammate@example.test')
		expect(html).toContain('support@example.test')
		expect(html).toContain('data-purchase-icon="email"')
		expect(html.match(/<h1/g)).toHaveLength(1)
	})

	it('reads the email off the purchase, without a second user lookup', async () => {
		await render()
		expect(mocks.getPurchaseWithUser).toHaveBeenCalledWith('purchase-1')
		expect(mocks.getProduct).toHaveBeenCalledWith('product-1')
	})

	it('is a 404 for an unknown purchase or one without a user', async () => {
		mocks.getPurchaseWithUser.mockResolvedValueOnce(null)
		await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
		mocks.getPurchaseWithUser.mockResolvedValueOnce({ id: 'p', productId: 'x', user: null })
		await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
		expect(mocks.getProduct).not.toHaveBeenCalled()
	})
})
