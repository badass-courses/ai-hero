import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const switchState = vi.hoisted(() => ({ closed: false }))
vi.mock('@/lib/c5-pricing/switch-server', () => ({
	c5PricingClosed: vi.fn(async () => switchState.closed),
}))
vi.mock('@/components/layout-client', () => ({ default: ({ children }: any) => <>{children}</> }))
vi.mock('@/components/landing/company-logo-grid', () => ({ CompanyLogoGrid: () => null }))
vi.mock('@/components/team-inquiry/team-inquiry-form', () => ({ TeamInquiryForm: () => <form /> }))
vi.mock('@/components/team-invoice/team-invoice-form', () => ({ TeamInvoiceForm: () => <form /> }))

import { C5SaleSwitch } from '@/components/c5-sale-switch'

import { CohortTeamCta } from './cohort-team-cta'
import { ForTeamsPage } from './for-teams-page'

afterEach(() => {
	vi.useRealTimers()
	switchState.closed = false
})

async function render(instant: string, backHref = '/workshops/ai-coding-crash-course') {
	vi.useFakeTimers()
	vi.setSystemTime(new Date(instant))
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<ForTeamsPage
				backHref={backHref}
				title="Crash Course"
				story={<p>Team story</p>}
				seats={<p>Seats</p>}
				invoice={{ productId: 'synthetic', mode: 'invoice' }}
				location={`${backHref}/for-teams`}
				source="synthetic"
				promotion={await C5SaleSwitch({ children: <CohortTeamCta /> })}
			/>
		</QueryClientProvider>,
	)
}

const open = '2026-11-01T12:00:00Z'
const closed = '2026-11-10T07:59:59Z'

describe('local team page HTML with the shared C5 sale switch', () => {
	it('renders the open offer, tracked cohort link, credit and quote anchor', async () => {
		const html = await render(open)
		expect(html).toContain('Software Factories for Real Engineers')
		expect(html).toContain('starts Monday Nov 9')
		expect(html).toContain('It builds on the Crash Course.')
		expect(html).toContain('See the cohort')
		expect(html).toContain('href="/s/c5-site-cta"')
		expect(html).toContain('Get a team quote')
		expect(html).toContain('one seat for each cohort seat')
		expect(html).toContain('id="contact"')
		expect(html).toContain('applied in the cart')
		expect(html).toContain('Net 30.')
		expect(html).not.toContain('enrollment close for a cohort')
		expect(html).not.toContain('—')
	})

	it.each([false, true])('leaves no promotion when time or pricing closes it (pricingClosed=%s)', async (pricingClosed) => {
		switchState.closed = pricingClosed
		const html = await render(pricingClosed ? open : closed)
		for (const text of ['team-cohort-title', 'Software Factories', 'one seat for each cohort seat', '/s/c5-site-cta', 'See the cohort', 'Get a team quote', 'enrollment closed']) {
			expect(html).not.toContain(text)
		}
		expect(html).toContain('id="contact"')
		expect(html).toContain('id="seats"')
		expect(html).toContain('id="invoice"')
	})

	it('keeps the enrollment-close invoice clause on cohort pages', async () => {
		expect(await render(closed, '/cohorts/synthetic')).toContain('Net 30 (by the enrollment close for a cohort).')
	})
})
