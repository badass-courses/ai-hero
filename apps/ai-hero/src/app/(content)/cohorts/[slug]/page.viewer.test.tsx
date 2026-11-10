import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	cohort: vi.fn(),
	data: vi.fn(),
	discord: vi.fn(),
	compile: vi.fn(),
}))
vi.mock('react', async (original) => ({
	...(await original<typeof import('react')>()),
	Suspense: () => null,
}))
vi.mock('next/link', () => ({
	default: ({ children, href, ...props }: any) => (
		<a href={href} {...props}>
			{children}
		</a>
	),
}))
vi.mock('next/image', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
	notFound: () => {
		throw new Error('not found')
	},
}))
vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/lib/cohorts-query', () => ({
	getCachedCohort: mocks.cohort,
	loadCohortPageData: mocks.data,
}))
vi.mock('@/lib/users', () => ({
	discordAccountsForCurrentUser: mocks.discord,
}))
vi.mock('@/utils/compile-mdx', () => ({ compileMDX: mocks.compile }))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/lib/subscriber-marketing/product-events', () => ({
	pageViewFact: () => null,
}))
vi.mock('@/lib/subscriber-marketing/product-events-live', () => ({
	scheduleProductEvents: vi.fn(),
}))
vi.mock('@/lib/c5-pricing/gift-server', () => ({
	giftEnrollmentAccess: async () => false,
	signedGiftFact: async () => null,
}))
vi.mock('@/lib/c5-pricing/gift-share', () => ({
	giftSharePresentation: async () => null,
	giftShareTitle: () => '',
}))
vi.mock('@/components/gift-share-attribution', () => ({
	GiftShareAttribution: () => null,
}))
vi.mock('@/lib/cohort-stats', () => ({
	getCachedCohortAlumniCount: async () => 0,
	formatAlumniCount: () => '',
}))
vi.mock('@/lib/product-slug-map', () => ({
	getActiveProductSlugMap: async () => ({}),
}))
vi.mock('@/lib/subscriber-gate', () => ({
	getSubscriberForGating: async () => null,
}))
vi.mock('@/lib/cta-gating', () => ({ isOnCohortWaitlist: () => false }))
vi.mock('@/components/cld-image', () => ({ CldImage: () => null }))
vi.mock('@/components/c5-past-cohort-callout', () => ({
	C5PastCohortCallout: () => null,
}))
vi.mock('@/components/cohort-waitlist-form', () => ({
	WaitlistForm: () => null,
}))
vi.mock('@/components/commerce/checkout-survey-buy-button', () => ({
	CheckoutSurveyBuyButton: () => null,
}))
vi.mock('@/components/contributor', () => ({ Contributor: () => null }))
vi.mock('@/components/mdx/mdx-components', () => ({
	DiscountCountdown: () => null,
}))
vi.mock('@/components/pricing/discount-deadline', () => ({
	DiscountDeadline: () => null,
}))
vi.mock('@/components/pricing/has-purchased', () => ({
	HasPurchased: () => null,
}))
vi.mock('@/components/pricing/pricing-inline', () => ({
	PricingInline: () => null,
}))
vi.mock('@/lib/structured-data', () => ({
	CourseStructuredData: () => null,
	ProductStructuredData: () => null,
}))
vi.mock('@coursebuilder/commerce-next/pricing/pricing', () => ({}))
vi.mock('../../_components/cohort-certificate-container', () => ({
	Certificate: () => null,
}))
vi.mock('../../workshops/_components/edit-workshop-button', () => ({
	EditWorkshopButton: () => null,
}))
vi.mock('./_components/cohort-certificate-progress', () => ({
	CohortCertificateProgress: () => null,
}))
vi.mock('./_components/cohort-fact-strip', () => ({
	CohortFactStrip: () => null,
}))
vi.mock('./_components/cohort-includes', () => ({
	CohortIncludes: () => null,
}))
vi.mock('./_components/cohort-sidebar', () => ({
	CohortSidebar: ({ children }: any) => children,
}))
vi.mock('./_components/cohort-pricing-widget-container', () => ({
	CohortPricingWidgetContainer: () => <p>Team or invite path</p>,
}))
vi.mock('./_components/cohort-enroll-price', () => ({
	CohortEnrollPrice: () => null,
}))
vi.mock('./_components/cohort-contents', () => ({
	CohortContents: () => <p>The workshops, including locked workshops</p>,
}))
vi.mock('@/components/office-hours-schedule', () => ({
	OfficeHoursSchedule: (props: any) => (
		<div data-schedule={JSON.stringify(props)} />
	),
}))

import { CohortPageView } from './page'

const workshop = (id: string, state: string, startsAt?: string) => ({
	id,
	type: 'workshop',
	fields: {
		slug: id,
		title: id === 'prep' ? 'Before We Start' : id,
		state,
		startsAt,
	},
	resources: [],
})
const sessions = Array.from({ length: 6 }, (_, index) => ({
	id: `office-${index + 1}`,
	title: `Office hours ${index + 1}`,
	startsAt: `2026-11-${String(5 + index).padStart(2, '0')}T17:00:00Z`,
	endsAt: `2026-11-${String(5 + index).padStart(2, '0')}T18:00:00Z`,
	youtubeBroadcastId: `synthetic-private-${index}`,
	youtubeWatchUrl: `https://youtube.com/watch?v=synthetic-private-${index}`,
}))
let cohort: any
let data: any
const render = async () =>
	renderToStaticMarkup(
		await CohortPageView({
			params: Promise.resolve({ slug: 'software-factories' }),
			searchParams: Promise.resolve({}),
		}),
	)
beforeEach(() => {
	vi.clearAllMocks()
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
	cohort = {
		id: 'cohort-test',
		type: 'cohort',
		fields: {
			slug: 'software-factories',
			title: 'Software Factories for Real Engineers',
			body: 'Sales pitch',
			startsAt: '2026-11-02T17:00:00Z',
			timezone: 'America/New_York',
			officeHoursSessions: sessions,
		},
		resources: [],
	}
	data = {
		cohort,
		session: { user: { id: 'learner' } },
		hasAccessToCohort: true,
		hasPurchasedCurrentProduct: true,
		commerceProps: {},
		workshops: [
			workshop('draft', 'draft'),
			workshop('future', 'published', '2026-12-01T00:00:00Z'),
			workshop('prep', 'published'),
		],
		workshopProgressMap: {},
		pricingDataLoader: Promise.resolve({}),
		product: {
			id: 'product-test',
			name: 'Software Factories',
			fields: { state: 'published' },
		},
	}
	mocks.cohort.mockImplementation(async () => cohort)
	mocks.data.mockImplementation(async () => data)
	mocks.discord.mockResolvedValue(false)
	mocks.compile.mockImplementation(async (source: string) => ({
		content: <p>{source}</p>,
	}))
})
afterEach(() => {
	vi.useRealTimers()
})

describe('cohort page viewers', () => {
	it('a buyer without post-purchase copy keeps the standard page and never sees the sales pitch', async () => {
		const html = await render()
		expect(html).toContain('You have purchased a ticket to this cohort.')
		expect(html).not.toContain('Sales pitch')
		expect(mocks.compile.mock.calls[0]![0]).toBe('')
	})
	it('team buyer without a seat keeps the existing team or invite path and no private sessions', async () => {
		data.hasAccessToCohort = false
		data.hasPurchasedCurrentProduct = false
		data.existingPurchase = null
		data.commerceProps = {
			purchases: [
				{
					id: 'team-purchase',
					productId: 'product-test',
					bulkCouponId: 'team-coupon',
					status: 'Valid',
				},
			],
		}
		const html = await render()
		expect(html).not.toContain('You have purchased a ticket')
		expect(html).toContain('Team or invite path')
		expect(html).not.toContain('youtubeWatchUrl')
		expect(html).not.toContain('synthetic-private')
		expect(mocks.discord).not.toHaveBeenCalled()
	})
	it('authored post-purchase copy fills the body slot with an access-gated office-hours widget', async () => {
		cohort.fields.postPurchaseBody =
			'Setup steps, Discord, Before We Start <OfficeHoursSchedule variant="lesson" />'
		const html = await render()
		expect(html).toContain('Setup steps, Discord, Before We Start')
		expect(html).toContain('You have purchased a ticket to this cohort.')
		expect(html).not.toContain('Sales pitch')
		const components = mocks.compile.mock.calls[0]![1]
		const widget = renderToStaticMarkup(components.OfficeHoursSchedule({}))
		expect(widget).toContain('synthetic-private')
	})
	it('a non-buyer sees the unchanged sales body with no private session props or MDX override', async () => {
		data.session = null
		data.hasAccessToCohort = false
		data.hasPurchasedCurrentProduct = false
		const html = await render()
		expect(html).toContain('Sales pitch')
		expect(html).not.toContain('youtubeWatchUrl')
		expect(html).not.toContain('synthetic-private')
		expect(mocks.compile.mock.calls[0]![1].OfficeHoursSchedule).toBeUndefined()
	})
})
