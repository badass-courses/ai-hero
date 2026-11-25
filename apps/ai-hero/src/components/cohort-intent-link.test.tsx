// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToReadableStream } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { CourseCtaClient } from '@/app/(content)/_components/course-cta-client'
import { ResourceListView } from '@/app/(content)/_components/resource-list-view'
import { WorkshopCompleteCard } from '@/app/(content)/workshops/_components/workshop-complete-card'
import { CoursesPage } from '@/app/courses/_components/courses-page'
import type { NextOffer } from '@/lib/next-offer'

import { CohortHero } from './cohort-hero'
import { CohortIntentLink } from './cohort-intent-link'
import { Hero } from './landing/hero'
import { PromoCard } from './mdx/promo-card'
import { SearchPalette } from './search-palette/search-palette'
import { PALETTE_PROMO } from './search-palette/search-palette-config'

type AnchorProps = React.ComponentProps<'a'>
const { prefetch, captureLink, sale } = vi.hoisted(() => ({
	prefetch: vi.fn(),
	captureLink: vi.fn((props: AnchorProps) => props),
	sale: { active: false },
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ prefetch }) }))
vi.mock('next/link', () => ({
	default: ({ prefetch, ...props }: AnchorProps & { prefetch?: boolean }) => {
		const anchor = { ...props, 'data-prefetch': prefetch }
		captureLink(anchor)
		return <a {...anchor} />
	},
}))
vi.mock('next/image', () => ({ default: () => null }))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/db/schema', () => ({ contentResource: {} }))
vi.mock('@/server/logger', () => ({ log: {} }))
vi.mock('@/utils/analytics', () => ({ track: vi.fn() }))
vi.mock('@/hooks/use-cta-gate', () => ({
	useCtaGate: () => ({ subscriber: null, isResolved: true }),
}))
vi.mock('@/trpc/react', () => ({
	api: { ability: { ownsResource: { useQuery: () => ({ status: 'success' }) } } },
}))
vi.mock('@/lib/cohorts-query', () => ({ getCachedCohort: async () => null }))
vi.mock('@/lib/cohort-stats', () => ({
	formatAlumniCount: () => null,
	getCachedCohortAlumniCount: async () => 0,
}))
vi.mock('@/lib/skills-query', () => ({ getSkillEntries: async () => [] }))
vi.mock('@/lib/subscriber-gate', () => ({ getSubscriberForGating: async () => null }))
vi.mock('./c5-sale-switch', () => ({
	C5SaleSwitch: ({ fallback, children }: { fallback: React.ReactNode; children: React.ReactNode }) =>
		sale.active ? children : fallback,
}))
vi.mock('./c5-join-cta', () => ({ C5JoinCta: () => null }))
vi.mock('./cohort-waitlist-form', () => ({ WaitlistForm: () => null }))
vi.mock('./landing/hero-shader', () => ({ HeroShader: () => null }))
vi.mock('./landing/lazy-hero-video', () => ({ HeroVideo: () => null }))
vi.mock('./brand/spot-illustration', () => ({ SpotIllustration: () => null }))
vi.mock('./landing/company-logo-grid', () => ({ CompanyLogoGrid: () => null }))
vi.mock('./subscriber-count', () => ({ SubscriberCount: () => null }))
vi.mock('./workshop-hero', () => ({ WorkshopHero: () => null }))
vi.mock('./navigation/timed-promo-bar-switch', () => ({ useFeaturedPromo: () => null }))
vi.mock('./search-palette/search-palette-config', async (importOriginal) => {
	const { PALETTE_PROMO } = await importOriginal<typeof import('./search-palette/search-palette-config')>()
	if (!PALETTE_PROMO) throw new Error('Missing palette promo fixture')
	return { PALETTE_PROMO, CURATED_DEFAULTS: [{ title: 'Cohort', href: PALETTE_PROMO.href, type: 'cohort' }] }
})
vi.mock('@/app/(content)/_components/module-progress-provider', () => ({
	useModuleProgress: () => ({ moduleProgress: { percentCompleted: 100 } }),
}))
vi.mock('@/app/(content)/_components/cohort-certificate-container', () => ({
	useCohortCertificateEligibility: () => false,
	CohortCertificateAction: () => null,
}))
vi.mock('@/app/(content)/workshops/_components/workshop-navigation-provider', () => ({
	useWorkshopNavigation: () => ({ id: 'workshop' }),
}))
vi.mock('@/app/(content)/workshops/_components/cohort-navigation-provider', () => ({
	useCohortNavigation: () => ({
		id: 'cohort', slug: 'example', title: 'Example',
		workshops: [{ id: 'workshop', slug: 'workshop', title: 'Workshop' }],
	}),
}))

const href = '/cohorts/example'
const offer: NextOffer = { kind: 'cohort-enroll', href, id: 'cohort', title: 'Example', label: 'Learn more' }
const flagship = { slug: 'example', id: 'cohort', title: 'Example', image: '/example.png' }
const workshopHref = '/workshops/workshop'
const workshopOffer: NextOffer = { ...offer, href: workshopHref, kind: 'workshop-buy' }
const latestWorkshop = {
	id: 'workshop', type: 'workshop' as const,
	fields: { slug: 'workshop', title: 'Workshop', state: 'published' as const, timezone: 'America/Los_Angeles', visibility: 'public' as const },
}

let root: ReturnType<typeof createRoot>
let container: HTMLDivElement

beforeEach(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	prefetch.mockClear()
	sale.active = false
	container = document.createElement('div')
	document.body.append(container)
	root = createRoot(container)
})

afterEach(async () => {
	await act(async () => root.unmount())
	container.remove()
	vi.unstubAllGlobals()
})

async function mount(element: React.ReactNode) {
	await act(async () => root.render(element))
}

function assertLinks(target: string, count: number, prefetchProp: string | null, onIntent: boolean) {
	const links = document.querySelectorAll<HTMLAnchorElement>(`a[href="${target}"]`)
	expect(links).toHaveLength(count)
	expect(prefetch).not.toHaveBeenCalled()
	for (const link of links) {
		expect(link.getAttribute('data-prefetch')).toBe(prefetchProp)
		link.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
		expect(prefetch.mock.calls).toEqual(onIntent ? [[target]] : [])
		prefetch.mockClear()
		link.focus()
		expect(prefetch.mock.calls).toEqual(onIntent ? [[target]] : [])
		prefetch.mockClear()
		link.blur()
	}
}

it('only prefetches cohort offers in the in-content CTA on intent', async () => {
	await mount(<CourseCtaClient offer={offer} />)
	assertLinks(href, 1, 'false', true)
	await mount(<CourseCtaClient offer={workshopOffer} />)
	assertLinks(workshopHref, 1, null, false)
})

it.each([false, true])('covers homepage hero actions with sale active: %s', async (active) => {
	sale.active = active
	captureLink.mockClear()
	// The homepage includes async server stats. Render it on the server, then
	// mount the link props to exercise their client-side event handlers.
	const stream = await renderToReadableStream(await Hero({ ctaHref: href, secondaryCtaHref: '/cohorts/second' }))
	await stream.allReady
	const links = captureLink.mock.calls.map(([props]) => props)
	await mount(links.map((props) => <a key={props.href} {...props} />))
	assertLinks(href, 1, 'false', true)
	if (!active) assertLinks('/cohorts/second', 1, 'false', true)
})

it('covers both the cohort hero artwork and the enrollment action', async () => {
	await mount(await CohortHero({ flagship, isPurchasable: true, alumniLabel: null, sale: null }))
	assertLinks(href, 2, 'false', true)
})

it('covers the running cohort strip, second offer, and past catalog card', async () => {
	await mount(<CoursesPage
		flagship={flagship}
		isPurchasable
		alumniLabel={null}
		latestWorkshop={latestWorkshop}
		pastCohorts={[{ ...flagship, id: 'past', slug: 'past' }]}
		sale={null}
		running={{ ...flagship, slug: 'running', endsAt: new Date('2030-01-01') }}
		featuredWorkshopOffer={workshopOffer}
		cohortDates={{ opens: null, starts: null }}
	/>)
	assertLinks('/cohorts/running', 1, 'false', true)
	assertLinks(href, 1, 'false', true)
	assertLinks('/cohorts/past', 1, 'false', true)
})

it('covers the lesson sidebar cohort breadcrumb', async () => {
	await mount(<ResourceListView
		title="Workshop"
		titleHref={workshopHref}
		breadcrumb={{ href, label: 'Example' }}
		moduleId="workshop"
		buildLessonHref={(slug) => `${workshopHref}/${slug}`}
		showAutoplay={false}
	/>)
	assertLinks(href, 1, 'false', true)
})

it('covers the cohort link after workshop completion', async () => {
	await mount(<WorkshopCompleteCard />)
	assertLinks(href, 1, 'false', true)
})

it('covers cohort promo cards in posts', async () => {
	await mount(<PromoCard variant="course" title="Example" description="Example" href={href} ctaLabel="Learn more" />)
	assertLinks(href, 1, 'false', true)
})

it('leaves shortlinks off even on intent and preserves explicit workshop prefetch', async () => {
	await mount(<>
		<CohortIntentLink href="/s/example">Shortlink</CohortIntentLink>
		<CohortIntentLink href={workshopHref} prefetch>Workshop</CohortIntentLink>
	</>)
	assertLinks('/s/example', 1, 'false', false)
	assertLinks(workshopHref, 1, 'true', false)
})

it('covers both the search palette cohort row and promo', async () => {
	if (!PALETTE_PROMO) throw new Error('Missing palette promo fixture')
	await mount(<SearchPalette open onOpenChange={vi.fn()} />)
	assertLinks(PALETTE_PROMO.href, 2, 'false', true)
})
