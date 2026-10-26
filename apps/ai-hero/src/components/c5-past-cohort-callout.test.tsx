import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ closed: false }))
vi.mock('@/lib/c5-pricing/switch-server', () => ({
	c5PricingClosed: vi.fn(async () => state.closed),
}))

import {
	C5PastCohortCallout,
	C5_PAST_COHORT_SLUGS,
} from './c5-past-cohort-callout'
import { C5SaleSwitch } from './c5-sale-switch'

async function markup(slug: string) {
	const element = C5PastCohortCallout({ slug })
	if (!element) return ''
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			{await C5SaleSwitch(element.props)}
		</QueryClientProvider>,
	)
}

afterEach(() => {
	vi.useRealTimers()
	state.closed = false
})

describe('past-cohort callout', () => {
	it.each(C5_PAST_COHORT_SLUGS)(
		'offers C5 on %s during enrollment, including alumni',
		async (slug) => {
			vi.useFakeTimers()
			vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
			const html = await markup(slug)
			expect(html).toContain('Enrollment for this cohort has closed.')
			expect(html).toContain('Software Factories for Real Engineers')
			expect(html).toContain('href="/s/c5-site-cta"')
			// No ownership input: alumni and non-owners get exactly the same callout.
		},
	)

	it.each(['2026-10-25T18:58:59Z', '2026-11-10T07:30:00Z'])(
		'disappears outside enrollment at %s',
		async (instant) => {
			vi.useFakeTimers()
			vi.setSystemTime(new Date(instant))
			expect(await markup(C5_PAST_COHORT_SLUGS[0])).toBe('')
		},
	)

	it('disappears with the pricing switch off', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
		state.closed = true
		expect(await markup(C5_PAST_COHORT_SLUGS[0])).toBe('')
	})

	it('never describes the current or an unrelated cohort as closed', async () => {
		expect(await markup('software-factories-for-real-engineers-xdy1m')).toBe('')
		expect(await markup('another-cohort')).toBe('')
	})
})
