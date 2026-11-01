import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }))
vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.useQuery }))

import {
	getNewsletterSignups,
	type NewsletterSignups,
} from '@/lib/analytics/newsletter-signups'
import {
	FAKE_SIGNUP_DAYS,
	fakeDrovr,
	SIGNUP_ENV,
	SIGNUP_NOW,
} from '@/lib/analytics/newsletter-signups.fixtures'
import { NewsletterSignupsPanel } from './newsletter-signups-panel'

let week: NewsletterSignups
let month: NewsletterSignups

beforeAll(async () => {
	const read = async (days: 7 | 30) => {
		const result = await getNewsletterSignups({
			days,
			env: SIGNUP_ENV,
			fetcher: fakeDrovr(FAKE_SIGNUP_DAYS),
			now: SIGNUP_NOW,
		})
		if (result.status !== 'available') throw new Error(result.reason)
		return result.data
	}
	week = await read(7)
	month = await read(30)
})

type QueryState = { data?: NewsletterSignups; isPending?: boolean; isError?: boolean }
let states: { '7d': QueryState; '30d': QueryState }

beforeEach(() => {
	mocks.useQuery.mockReset()
	mocks.useQuery.mockImplementation(
		({ queryKey }: { queryKey: string[] }) =>
			states[queryKey[2] as '7d' | '30d'],
	)
})

const render = () => renderToStaticMarkup(<NewsletterSignupsPanel />)
/** The text of one day's table row, tags stripped. */
const row = (html: string, day: string) =>
	html
		.match(new RegExp(`<tr[^>]*data-day="${day}"[^>]*>(.*?)</tr>`))?.[1]
		?.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
const options = (range: '7d' | '30d') =>
	mocks.useQuery.mock.calls.find(([o]) => o.queryKey[2] === range)![0]

describe('newsletter signups panel', () => {
	it("renders drovr's numbers with plain source names", () => {
		states = { '7d': { data: week }, '30d': { data: month } }
		const html = render()
		expect(html).toContain('>927<')
		expect(html).toContain('>972<')
		expect(html).toContain('Site signups')
		expect(html).toContain('Kit-only arrivals')
		expect(html).toContain('Imported lists')
		expect(html).toContain('>unattributed<')
		expect(html).toContain('>unknown<')
		// Day, New, list-import, ai-hero, kit, unattributed, unknown, confirmed, unsubscribes.
		expect(row(html, '2026-10-28')).toBe('Wed, Oct 28 580 500 80 0 0 0 60 0')
		expect(html).toContain('310 confirmed · 10 unsubscribes (all contacts)')
	})

	it('labels unsubscribes as all contacts, not newsletter churn', () => {
		states = { '7d': { data: week }, '30d': { data: month } }
		const html = render()
		expect(html).toContain('Unsubscribes (all contacts)')
		expect(html).toContain('They are not newsletter churn.')
	})

	it('shows the last 7 days while the older days are still loading', () => {
		states = { '7d': { data: week }, '30d': { isPending: true } }
		const html = render()
		expect(html).toContain('>927<')
		expect(html).toContain('Loading older days…')
		expect(row(html, '2026-10-26')).toBeDefined()
		expect(row(html, '2026-10-25')).toBeUndefined()
		expect(html).not.toContain('>972<')
	})

	it('waits for the last 7 days before asking for the older days', () => {
		states = { '7d': { isPending: true }, '30d': { isPending: true } }
		expect(render()).toContain('Loading newsletter signups…')
		expect(options('7d').enabled).toBe(true)
		expect(options('30d').enabled).toBe(false)
		states = { '7d': { data: week }, '30d': { isPending: true } }
		mocks.useQuery.mockClear()
		render()
		expect(options('30d').enabled).toBe(true)
	})

	it('shows an unavailable state when the reads fail, never zero', () => {
		states = { '7d': { isError: true }, '30d': { isError: true } }
		const html = render()
		expect(html).toContain('Newsletter signups are unavailable right now')
		expect(html).not.toMatch(/>0</)
	})

	it('keeps the 7-day numbers and marks the 30-day total unavailable when only the older read fails', () => {
		states = { '7d': { data: week }, '30d': { isError: true } }
		const html = render()
		expect(html).toContain('>927<')
		expect(html).toMatch(
			/>unavailable<\/div><div[^>]*>New subscribers, last 30 days/,
		)
	})

	it('draws a missing day as unavailable, not as zero', () => {
		states = { '7d': { data: week }, '30d': { data: month } }
		const html = render()
		expect(row(html, '2026-10-29')).toBe('Thu, Oct 29 unavailable')
		expect(html).toContain('6 of 7 days reported · 1 day still counting')
	})

	it('marks today as counting so far', () => {
		states = { '7d': { data: week }, '30d': { data: month } }
		expect(row(render(), '2026-11-01')).toBe(
			'Sun, Nov 1 so far 25 0 25 0 0 0 10 0',
		)
	})

	it('shows the totals as the sum of the drawn days', () => {
		states = { '7d': { data: week }, '30d': { data: month } }
		const html = render()
		const drawn = month.days
			.map((day) => row(html, day.day)!)
			.filter((text) => !text.endsWith('unavailable'))
			.map((text) =>
				Number(text.replace(/^\w+, \w+ \d+ (so far )?/, '').split(' ')[0]),
			)
		const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
		expect(sum(drawn)).toBe(972)
		expect(sum(drawn.slice(-6))).toBe(927)
		expect(html).toContain(`>${sum(drawn)}<`)
	})

	it('fetches each window from the analytics route with the cancellation signal', async () => {
		states = { '7d': { isPending: true }, '30d': { isPending: true } }
		render()
		const fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, data: week }),
		})
		vi.stubGlobal('fetch', fetch)
		try {
			const signal = new AbortController().signal
			await expect(options('7d').queryFn({ signal })).resolves.toBe(week)
			await options('30d').queryFn({ signal })
			expect(fetch.mock.calls).toEqual([
				[
					'/api/analytics?surface=newsletter%2Fsignups&range=7d',
					{ signal, cache: 'no-store' },
				],
				[
					'/api/analytics?surface=newsletter%2Fsignups&range=30d',
					{ signal, cache: 'no-store' },
				],
			])
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('turns a 503 from the route into the unavailable state', async () => {
		states = { '7d': { isPending: true }, '30d': { isPending: true } }
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
				options('7d').queryFn({ signal: new AbortController().signal }),
			).rejects.toThrow('unavailable')
		} finally {
			vi.unstubAllGlobals()
		}
	})
})
