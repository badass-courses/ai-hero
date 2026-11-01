import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }))
vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.useQuery }))

import {
	getNewsletterSignups,
	type NewsletterSignups,
} from '@/lib/analytics/newsletter-signups'
import {
	FAKE_SIGNUP_DAYS,
	respondWith,
	SIGNUP_ENV,
	SIGNUP_NOW,
	signupCountsBody,
} from '@/lib/analytics/newsletter-signups.fixtures'
import { NewsletterSignupsPanel } from './newsletter-signups-panel'

let data: NewsletterSignups

beforeAll(async () => {
	const read = await getNewsletterSignups({
		env: SIGNUP_ENV,
		fetcher: respondWith(signupCountsBody(FAKE_SIGNUP_DAYS)),
		now: SIGNUP_NOW,
	})
	if (read.status !== 'available') throw new Error(read.reason)
	data = read.data
})

const render = () => renderToStaticMarkup(<NewsletterSignupsPanel />)
/** The text of one day's table row, tags stripped. */
const row = (html: string, day: string) =>
	html
		.match(new RegExp(`<tr[^>]*data-day="${day}"[^>]*>(.*?)</tr>`))?.[1]
		?.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()

describe('newsletter signups panel', () => {
	it("renders drovr's numbers with plain source names", () => {
		mocks.useQuery.mockReturnValue({ data })
		const html = render()
		// 7-day and 30-day totals.
		expect(html).toContain('927')
		expect(html).toContain('969')
		expect(html).toContain('Site signups')
		expect(html).toContain('Kit-only arrivals')
		expect(html).toContain('Imported lists')
		expect(row(html, '2026-10-28')).toBe('Wed, Oct 28 580 500 80 0 0 60 0')
		expect(html).toContain('310 confirmed · 10 unsubscribed')
	})

	it('shows an unavailable state when the read fails, never zero', () => {
		mocks.useQuery.mockReturnValue({ isError: true })
		const html = render()
		expect(html).toContain('Newsletter signups are unavailable right now')
		expect(html).not.toMatch(/>0</)
	})

	it('draws a missing day as unavailable, not as zero', () => {
		mocks.useQuery.mockReturnValue({ data })
		const html = render()
		expect(row(html, '2026-10-29')).toBe('Thu, Oct 29 unavailable')
		expect(html).toContain('6 of 7 days reported · 1 day still counting')
	})

	it('marks today as counting so far', () => {
		mocks.useQuery.mockReturnValue({ data })
		expect(row(render(), '2026-11-01')).toBe('Sun, Nov 1 so far 25 0 25 0 0 10 0')
	})

	it('shows the totals as the sum of the drawn days', () => {
		mocks.useQuery.mockReturnValue({ data })
		const html = render()
		const lastSeven = [
			'2026-10-26',
			'2026-10-27',
			'2026-10-28',
			'2026-10-29',
			'2026-10-30',
			'2026-10-31',
			'2026-11-01',
		].map((day) => row(html, day)!)
		const drawn = lastSeven
			.filter((text) => !text.endsWith('unavailable'))
			.map((text) => Number(text.replace(/^\w+, \w+ \d+ (so far )?/, '').split(' ')[0]))
		const sum = drawn.reduce((a, b) => a + b, 0)
		expect(sum).toBe(data.totals.last7.subscribed.total)
		expect(html).toContain(`>${sum}<`)
	})

	it('fetches the analytics route with the query cancellation signal', async () => {
		mocks.useQuery.mockReturnValue({ isPending: true })
		expect(render()).toContain('Loading newsletter signups…')
		const fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, data }),
		})
		vi.stubGlobal('fetch', fetch)
		try {
			const signal = new AbortController().signal
			await expect(
				mocks.useQuery.mock.calls.at(-1)?.[0].queryFn({ signal }),
			).resolves.toBe(data)
			expect(fetch).toHaveBeenCalledWith(
				'/api/analytics?surface=newsletter%2Fsignups',
				{ signal, cache: 'no-store' },
			)
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('turns a 503 from the route into the unavailable state', async () => {
		mocks.useQuery.mockReturnValue({ isPending: true })
		render()
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: false,
				json: async () => ({ ok: false, error: { code: 'SIGNUPS_UNAVAILABLE' } }),
			}),
		)
		try {
			await expect(
				mocks.useQuery.mock.calls.at(-1)?.[0].queryFn({
					signal: new AbortController().signal,
				}),
			).rejects.toThrow('unavailable')
		} finally {
			vi.unstubAllGlobals()
		}
	})
})
