import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Route contract for /workshops/[module]/for-teams after the shared
// ForTeamsPage extraction: same 404 rule, seats only for a self-paced
// product, and the invoice band follows the product's sale state.

const mocks = vi.hoisted(() => ({
	workshop: null as any,
	product: null as any,
}))

vi.mock('next/navigation', () => ({
	notFound: () => {
		throw new Error('NEXT_NOT_FOUND')
	},
}))
vi.mock('@/lib/workshops-query', () => ({
	getCachedMinimalWorkshop: vi.fn(async () => mocks.workshop),
	getCachedWorkshopProduct: vi.fn(async () => mocks.product),
}))
vi.mock('@/utils/compile-mdx', () => ({
	compileMDX: vi.fn(async (source: string) => ({ content: source })),
}))
vi.mock('@/lib/team-invoice/team-invoice-server', () => ({
	isTeamInvoicingEnabled: () => true,
}))
vi.mock('@/components/for-teams/for-teams-page', () => ({
	ForTeamsPage: (props: unknown) => props,
	FOR_TEAMS_INNER: '',
}))
vi.mock('../../_components/workshop-pricing', () => ({
	WorkshopPricingClient: () => null,
	WorkshopPricingFallback: () => null,
}))
vi.mock('../../_components/workshop-public-pricing-server', () => ({
	PublicWorkshopPricing: () => null,
}))

import { ForTeamsPage } from '@/components/for-teams/for-teams-page'

import WorkshopForTeamsPage from './page'

const workshop = (forTeamsBody?: string) => ({
	id: 'workshop-test',
	type: 'workshop',
	fields: {
		title: 'Test Workshop',
		slug: 'test-workshop',
		description: 'A test workshop',
		...(forTeamsBody === undefined ? {} : { forTeamsBody }),
	},
})

const product = (overrides: Record<string, unknown> = {}) => ({
	id: 'product-test',
	type: 'self-paced',
	status: 1,
	quantityAvailable: -1,
	fields: { state: 'published', visibility: 'public' },
	...overrides,
})

const render = async () => {
	const element = (await WorkshopForTeamsPage({
		params: Promise.resolve({ module: 'test-workshop' }),
	})) as React.ReactElement<any>
	expect(element.type).toBe(ForTeamsPage)
	return element.props
}

describe('/workshops/[module]/for-teams', () => {
	beforeEach(() => {
		mocks.product = product()
	})

	it('404s without a team story', async () => {
		mocks.workshop = workshop()
		await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
		mocks.workshop = workshop('')
		await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
	})

	it('sells seats and invoices for a published self-paced product', async () => {
		mocks.workshop = workshop('## Team story')
		const props = await render()
		expect(props.backHref).toBe('/workshops/test-workshop')
		expect(props.location).toBe('/workshops/test-workshop/for-teams')
		expect(props.source).toBe('test-workshop')
		expect(props.story).toBe('## Team story')
		expect(props.seats).not.toBeNull()
		expect(props.invoice).toEqual({ productId: 'product-test', mode: 'invoice' })
	})

	it('offers no seats or invoice for a product that is not self-paced', async () => {
		mocks.workshop = workshop('## Team story')
		mocks.product = product({ type: 'membership' })
		const props = await render()
		expect(props.seats).toBeNull()
		expect(props.invoice).toBeNull()
	})

	it('takes an invoice request while the product is unpublished', async () => {
		mocks.workshop = workshop('## Team story')
		mocks.product = product({ fields: { state: 'draft', visibility: 'public' } })
		const props = await render()
		expect(props.invoice).toMatchObject({ mode: 'request' })
	})
})
