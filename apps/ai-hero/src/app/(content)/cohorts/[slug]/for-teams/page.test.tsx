import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Route contract for /cohorts/[slug]/for-teams, the workshop team page's
// twin: no `forTeamsBody`, no page; otherwise the shared ForTeamsPage with a
// checkout only while the cohort is on sale, and an invoice band that sends
// invoices only when the product's invoicing is switched on.

const mocks = vi.hoisted(() => ({
	cohort: null as any,
	purchaseCount: 0,
	invoicingEnabled: true,
}))

vi.mock('next/navigation', () => ({
	notFound: () => {
		throw new Error('NEXT_NOT_FOUND')
	},
}))
vi.mock('@/lib/cohorts-query', () => ({
	getCachedCohort: vi.fn(async () => mocks.cohort),
}))
vi.mock('@/db', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({
					then: (resolve: (rows: { count: number }[]) => unknown) =>
						Promise.resolve(resolve([{ count: mocks.purchaseCount }])),
				}),
			}),
		}),
	},
}))
vi.mock('@/db/schema', () => ({ purchases: { productId: 'productId' } }))
vi.mock('@/utils/compile-mdx', () => ({
	compileMDX: vi.fn(async (source: string) => ({
		content: <div data-story>{source}</div>,
	})),
}))
vi.mock('@/lib/team-invoice/team-invoice-server', () => ({
	isTeamInvoicingEnabled: () => mocks.invoicingEnabled,
}))
vi.mock('@/components/for-teams/for-teams-page', () => ({
	ForTeamsPage: (props: unknown) => props,
}))
vi.mock('@/components/cld-image', () => ({ CldImage: () => null }))
vi.mock('../../../workshops/_components/workshop-pricing', () => ({
	WorkshopPricingClient: () => null,
	WorkshopPricingFallback: () => null,
}))
vi.mock(
	'../../../workshops/_components/workshop-public-pricing-server',
	() => ({ PublicProductPricing: () => null }),
)

import { ForTeamsPage } from '@/components/for-teams/for-teams-page'

import CohortForTeamsPage from './page'

const DAY = 24 * 60 * 60 * 1000
const iso = (offset: number) => new Date(Date.now() + offset).toISOString()

const cohort = (
	productFields: Record<string, unknown>,
	forTeamsBody: string | null = '## Bring your team',
) => ({
	id: 'cohort-test',
	type: 'cohort',
	fields: {
		title: 'Test Cohort',
		slug: 'test-cohort-abc12',
		description: 'A test cohort',
		timezone: 'America/Los_Angeles',
		...(forTeamsBody === null ? {} : { forTeamsBody }),
	},
	resourceProducts: [
		{
			resourceId: 'cohort-test',
			productId: 'product-test',
			product: {
				id: 'product-test',
				name: 'Test Cohort',
				type: 'cohort',
				status: 1,
				quantityAvailable: -1,
				createdAt: new Date(),
				fields: { slug: 'test-cohort-product', ...productFields },
			},
		},
	],
})

const render = async (slug = 'test-cohort-abc12') => {
	const element = (await CohortForTeamsPage({
		params: Promise.resolve({ slug }),
	})) as React.ReactElement<any>
	expect(element.type).toBe(ForTeamsPage)
	return element.props
}

describe('/cohorts/[slug]/for-teams', () => {
	beforeEach(() => {
		mocks.purchaseCount = 0
		mocks.invoicingEnabled = true
	})

	it('404s when the cohort has no team story', async () => {
		mocks.cohort = cohort({ state: 'published' }, null)
		await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
		mocks.cohort = cohort({ state: 'published' }, '')
		await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
	})

	it('404s for an unknown cohort', async () => {
		mocks.cohort = null
		await expect(render('nope')).rejects.toThrow('NEXT_NOT_FOUND')
	})

	it('sells seats and invoices while enrollment is open', async () => {
		mocks.cohort = cohort({
			state: 'published',
			openEnrollment: iso(-DAY),
			closeEnrollment: iso(DAY),
		})
		const props = await render()
		expect(props.backHref).toBe('/cohorts/test-cohort-abc12')
		expect(props.location).toBe('/cohorts/test-cohort-abc12/for-teams')
		expect(props.title).toBe('Test Cohort')
		expect(props.seats).not.toBeNull()
		expect(props.invoice).toEqual({ productId: 'product-test', mode: 'invoice' })
	})

	it('has no checkout before enrollment opens, only the request and inquiry', async () => {
		mocks.cohort = cohort({
			state: 'published',
			openEnrollment: iso(7 * DAY),
		})
		const props = await render()
		expect(props.seats).toBeNull()
		expect(props.invoice).toMatchObject({
			productId: 'product-test',
			mode: 'request',
		})
		expect(props.invoice.lead).toMatch(/^Seats open /)
		expect(props.source).toBe('test-cohort-abc12')
	})

	it('has no checkout for an unpublished cohort product', async () => {
		mocks.cohort = cohort({ state: 'draft' })
		const props = await render()
		expect(props.seats).toBeNull()
		expect(props.invoice).toMatchObject({ mode: 'request' })
	})

	it('drops the invoice band once enrollment has closed', async () => {
		mocks.cohort = cohort({
			state: 'published',
			openEnrollment: iso(-7 * DAY),
			closeEnrollment: iso(-DAY),
		})
		const props = await render()
		expect(props.seats).toBeNull()
		expect(props.invoice).toBeNull()
	})

	it('takes requests instead of invoices while invoicing is off', async () => {
		mocks.invoicingEnabled = false
		mocks.cohort = cohort({
			state: 'published',
			openEnrollment: iso(-DAY),
		})
		const props = await render()
		expect(props.seats).not.toBeNull()
		expect(props.invoice).toEqual({ productId: 'product-test', mode: 'request' })
	})

	it('treats a sold-out cohort as closed', async () => {
		mocks.purchaseCount = 20
		mocks.cohort = cohort({ state: 'published', openEnrollment: iso(-DAY) })
		mocks.cohort.resourceProducts[0].product.quantityAvailable = 20
		const props = await render()
		expect(props.seats).toBeNull()
		expect(props.invoice).toBeNull()
	})
})
