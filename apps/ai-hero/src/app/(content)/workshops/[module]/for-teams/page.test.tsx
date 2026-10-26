import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Route contract for /workshops/[module]/for-teams after the shared
// ForTeamsPage extraction: same 404 rule, seats only for a self-paced
// product, and the invoice band follows the product's sale state.

const mocks = vi.hoisted(() => ({
	workshop: null as any,
	product: null as any,
	pricingClosed: false,
}))

vi.mock('@/lib/c5-pricing/switch-server', () => ({
	c5PricingClosed: vi.fn(async () => mocks.pricingClosed),
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

import { c5PricingClosed } from '@/lib/c5-pricing/switch-server'

import WorkshopForTeamsPage, { dynamic, revalidate } from './page'

afterEach(() => {
	vi.useRealTimers()
})

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
		mocks.pricingClosed = false
		vi.clearAllMocks()
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

	it.each([
		['2026-10-25T18:58:59.999Z', false, false],
		['2026-10-25T18:59:00.000Z', false, true],
		['2026-11-01T12:00:00.000Z', false, true],
		['2026-11-01T12:00:00.000Z', true, false],
		['2026-11-10T07:30:00.000Z', false, false],
		['2026-11-11T12:00:00.000Z', false, false],
	])('renders the promotion at %s with pricing closed=%s: %s', async (instant, closed, active) => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(instant))
		mocks.pricingClosed = closed
		mocks.workshop = workshop('## Team story')
		const page = await WorkshopForTeamsPage({
			params: Promise.resolve({ module: 'ai-coding-crash-course' }),
		})
		const html = renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				{page.props.promotion}
			</QueryClientProvider>,
		)
		if (active) {
			expect(html).toContain('Take your team further')
			expect(html).toContain('href="/s/c5-site-cta"')
			expect(html).toContain('href="#contact"')
			expect(html).toContain('one seat for each cohort seat')
		} else {
			expect(html).toBe('')
		}
	})

	it('does not load or promote C5 on other workshop team pages', async () => {
		mocks.workshop = workshop('## Team story')
		expect((await render()).promotion).toBeNull()
		expect(c5PricingClosed).not.toHaveBeenCalled()
	})

	it('does not cache time-sensitive route HTML', () => {
		expect(dynamic).toBe('force-dynamic')
		expect(revalidate).toBe(0)
	})

	it('takes an invoice request while the product is unpublished', async () => {
		mocks.workshop = workshop('## Team story')
		mocks.product = product({ fields: { state: 'draft', visibility: 'public' } })
		const props = await render()
		expect(props.invoice).toMatchObject({ mode: 'request' })
	})
})
