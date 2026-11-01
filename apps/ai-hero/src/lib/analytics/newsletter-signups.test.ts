import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	FAKE_SIGNUP_DAYS as DAYS,
	fakeDrovr,
	json,
	SIGNUP_ENV as env,
	SIGNUP_NOW as now,
	signupCountsBody,
	signupDay as day,
} from './newsletter-signups.fixtures'
import {
	getNewsletterSignups,
	SIGNUP_COUNTS_TIMEOUT_MS,
} from './newsletter-signups'

afterEach(() => {
	vi.useRealTimers()
})

async function available(
	fetcher: ReturnType<typeof fakeDrovr>,
	days: 7 | 30 = 30,
) {
	const read = await getNewsletterSignups({ days, env, fetcher, now })
	if (read.status !== 'available') throw new Error(read.reason)
	return read
}

describe('newsletter signups from drovr', () => {
	it('reads 30 days a week at a time, newest first, with the tenant key', async () => {
		const fetcher = fakeDrovr(DAYS)
		const { data } = await available(fetcher)

		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			'https://drovr.test/signup-counts?from=2026-10-26&to=2026-11-01',
			'https://drovr.test/signup-counts?from=2026-10-19&to=2026-10-25',
			'https://drovr.test/signup-counts?from=2026-10-12&to=2026-10-18',
			'https://drovr.test/signup-counts?from=2026-10-05&to=2026-10-11',
			'https://drovr.test/signup-counts?from=2026-10-03&to=2026-10-04',
		])
		expect(fetcher.mock.calls[0]![1]).toMatchObject({
			headers: { authorization: 'Bearer synthetic-key' },
		})
		expect(data).toMatchObject({
			from: '2026-10-03',
			to: '2026-11-01',
			windowDays: 30,
		})
		expect(data.days).toHaveLength(30)
		expect(data.days[0]).toEqual({
			day: '2026-10-03',
			status: 'complete',
			subscribed: { total: 42, bySource: { 'ai-hero': 40, kit: 2 } },
			confirmed: 30,
			unsubscribed: 1,
		})
		expect(data.sources).toEqual([
			'list-import',
			'ai-hero',
			'kit',
			'unattributed',
			'unknown',
		])
	})

	it('reads only the last week in one call for the 7-day window', async () => {
		const fetcher = fakeDrovr(DAYS)
		const { data } = await available(fetcher, 7)
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(data.days.map((d) => d.day)).toEqual([
			'2026-10-26',
			'2026-10-27',
			'2026-10-28',
			'2026-10-29',
			'2026-10-30',
			'2026-10-31',
			'2026-11-01',
		])
		expect(data.totals.last30).toBeNull()
		expect(data.totals.last7.subscribed.total).toBe(927)
	})

	it('keeps an absent day unavailable instead of filling it with zero', async () => {
		const { data } = await available(fakeDrovr(DAYS))
		expect(data.days.find((d) => d.day === '2026-10-29')).toEqual({
			day: '2026-10-29',
			status: 'unavailable',
		})
		expect(data.totals.last30).toMatchObject({
			days: 30,
			reportedDays: 8,
			complete: false,
		})
	})

	it('draws an incomplete day as partial and says so in the totals', async () => {
		const { data } = await available(fakeDrovr(DAYS))
		expect(data.days.at(-1)).toMatchObject({
			day: '2026-11-01',
			status: 'partial',
			subscribed: { total: 25 },
		})
		expect(data.totals.last7).toMatchObject({
			days: 7,
			reportedDays: 6,
			partialDays: 1,
			complete: false,
		})
	})

	it('adds totals up from the reported days', async () => {
		const { last7, last30 } = (await available(fakeDrovr(DAYS))).data.totals
		// 2026-10-26..2026-11-01, without the absent 2026-10-29.
		expect(last7.subscribed).toEqual({
			total: 101 + 90 + 580 + 71 + 60 + 25,
			bySource: {
				'ai-hero': 425,
				unknown: 1,
				'list-import': 500,
				kit: 1,
				unattributed: 0,
			},
		})
		expect(last7.confirmed).toBe(80 + 70 + 60 + 50 + 40 + 10)
		expect(last7.unsubscribed).toBe(3 + 2 + 0 + 4 + 1 + 0)
		expect(last30!.subscribed.total).toBe(last7.subscribed.total + 42 + 3)
		expect(
			Object.values(last30!.subscribed.bySource).reduce((a, b) => a + b, 0),
		).toBe(last30!.subscribed.total)
	})

	it('reports confirmed and unsubscribed as unknown when drovr leaves them out', async () => {
		const { data } = await available(
			fakeDrovr([
				day('2026-10-31', { 'ai-hero': 3 }, { confirmed: 2 }),
				day('2026-11-01', { 'ai-hero': 1 }, { complete: false }),
			]),
			7,
		)
		expect(data.days.at(-1)).toMatchObject({
			confirmed: null,
			unsubscribed: null,
		})
		expect(data.totals.last7).toMatchObject({
			confirmed: null,
			unsubscribed: null,
		})
	})

	it('leaves a failed week unavailable and keeps the weeks that answered', async () => {
		const read = await available(
			fakeDrovr(DAYS, (from) =>
				from === '2026-10-26' ? json({ error: 'busy' }, 503) : undefined,
			),
		)
		expect(read.gaps).toEqual(['drovr signup-counts read failed (503)'])
		expect(
			read.data.days.slice(-7).every((d) => d.status === 'unavailable'),
		).toBe(true)
		expect(read.data.days[0]!.status).toBe('complete')
		expect(read.data.totals.last7).toMatchObject({
			reportedDays: 0,
			subscribed: { total: 0 },
		})
	})

	it('drops a week whose answer carries an address-like source, and never shows it', async () => {
		const read = await available(
			fakeDrovr(DAYS, (from, to) =>
				from === '2026-10-26'
					? json(
							signupCountsBody(from, to, [
								day('2026-11-01', { 'someone@example.test': 1 }),
							]),
						)
					: undefined,
			),
		)
		expect(read.gaps).toEqual(['drovr signup-counts response is invalid'])
		expect(JSON.stringify(read.data)).not.toContain('@')
	})

	it.each([
		['a refused read', () => json({ error: 'nope' }, 503)],
		[
			'another tenant',
			(from: string, to: string) =>
				json({ ...signupCountsBody(from, to, DAYS), tenantId: 'org-other' }),
		],
		[
			'a total that is not the sum of its sources',
			(from: string, to: string) =>
				json(
					signupCountsBody(from, to, [
						{
							...day('2026-11-01', { 'ai-hero': 2 }),
							subscribed: { total: 5, bySource: { 'ai-hero': 2 } },
						},
					]),
				),
		],
		[
			'a different window',
			(from: string, to: string) =>
				json({ ...signupCountsBody(from, to, DAYS), from: '2026-10-02' }),
		],
		[
			'a duplicated day',
			(from: string, to: string) =>
				json({
					...signupCountsBody(from, to, []),
					days: [DAYS[1]!, DAYS[1]!],
				}),
		],
		[
			'a day outside the window',
			(from: string, to: string) =>
				json({
					...signupCountsBody(from, to, []),
					days: [day('2026-11-02', { kit: 1 })],
				}),
		],
	])('is unavailable on %s', async (_, answer) => {
		const read = await getNewsletterSignups({
			days: 7,
			env,
			fetcher: fakeDrovr(DAYS, answer),
			now,
		})
		expect(read.status).toBe('unavailable')
	})

	it('is unavailable when every week fails', async () => {
		const read = await getNewsletterSignups({
			env,
			fetcher: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
			now,
		})
		expect(read).toEqual({
			status: 'unavailable',
			reason: 'drovr signup-counts read failed',
		})
	})

	it('is unavailable without drovr credentials, and never calls out', async () => {
		const fetcher = vi.fn()
		const read = await getNewsletterSignups({ env: {}, fetcher, now })
		expect(read).toEqual({
			status: 'unavailable',
			reason: 'drovr credentials are not configured',
		})
		expect(fetcher).not.toHaveBeenCalled()
	})

	it('gives up on a slow drovr after the timeout and reads unavailable', async () => {
		vi.useFakeTimers()
		const fetcher = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_, reject) => {
					init.signal!.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError')),
					)
				}),
		)
		const pending = getNewsletterSignups({
			days: 7,
			env,
			fetcher: fetcher as unknown as typeof fetch,
			now,
		})
		// A cold 7-day read takes about 5 s; it must not be cut off early.
		await vi.advanceTimersByTimeAsync(6_500)
		expect(fetcher.mock.calls[0]![1].signal!.aborted).toBe(false)
		await vi.advanceTimersByTimeAsync(SIGNUP_COUNTS_TIMEOUT_MS - 6_500)
		expect(await pending).toEqual({
			status: 'unavailable',
			reason: 'drovr signup-counts read timed out',
		})
	})
})
