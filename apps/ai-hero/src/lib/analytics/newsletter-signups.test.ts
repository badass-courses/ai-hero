import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	FAKE_SIGNUP_DAYS as DAYS,
	fakeDrovr,
	HISTORY_ENV,
	json,
	kitHistory,
	SEAM_DROVR_DAYS,
	SEAM_NOW,
	SIGNUP_ENV as env,
	SIGNUP_ENV as SIGNUP_ENV_ONLY,
	SIGNUP_NOW as now,
	signupCountsBody,
	signupDay as day,
} from './newsletter-signups.fixtures'
import {
	getNewsletterSignups,
	SIGNUP_COUNTS_TIMEOUT_MS,
} from './newsletter-signups'
import { mergeSignupReads, type SignupRange } from './newsletter-signups-series'

afterEach(() => {
	vi.useRealTimers()
})

async function available(
	fetcher: ReturnType<typeof fakeDrovr>,
	range: SignupRange = '30d',
	options: { env?: Record<string, string>; now?: number } = {},
) {
	const read = await getNewsletterSignups({
		range,
		env: options.env ?? env,
		fetcher,
		now: options.now ?? now,
	})
	if (read.status !== 'available') throw new Error(read.reason)
	return read
}

describe('newsletter signups from drovr', () => {
	it('reads 30 days a week at a time, newest first, with the tenant key', async () => {
		const fetcher = fakeDrovr(DAYS)
		const { data } = await available(fetcher)

		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			'https://drovr.test/signup-counts?from=2026-12-14&to=2026-12-20',
			'https://drovr.test/signup-counts?from=2026-12-07&to=2026-12-13',
			'https://drovr.test/signup-counts?from=2026-11-30&to=2026-12-06',
			'https://drovr.test/signup-counts?from=2026-11-23&to=2026-11-29',
			'https://drovr.test/signup-counts?from=2026-11-21&to=2026-11-22',
		])
		expect(fetcher.mock.calls[0]![1]).toMatchObject({
			headers: { authorization: 'Bearer synthetic-key' },
		})
		expect(data).toMatchObject({
			from: '2026-11-21',
			to: '2026-12-20',
			windowDays: 30,
		})
		expect(data.days).toHaveLength(30)
		expect(data.days[0]).toEqual({
			day: '2026-11-21',
			source: 'drovr',
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
		const { data } = await available(fetcher, '7d')
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(data.days.map((d) => d.day)).toEqual([
			'2026-12-14',
			'2026-12-15',
			'2026-12-16',
			'2026-12-17',
			'2026-12-18',
			'2026-12-19',
			'2026-12-20',
		])
		expect(data.totals.last30).toBeNull()
		expect(data.totals.last7.subscribed.total).toBe(927)
	})

	it('keeps an absent day unavailable instead of filling it with zero', async () => {
		const { data } = await available(fakeDrovr(DAYS))
		expect(data.days.find((d) => d.day === '2026-12-17')).toEqual({
			day: '2026-12-17',
			source: 'drovr',
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
			day: '2026-12-20',
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
		// 2026-12-14..2026-12-20, without the absent 2026-12-17.
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
				day('2026-12-19', { 'ai-hero': 3 }, { confirmed: 2 }),
				day('2026-12-20', { 'ai-hero': 1 }, { complete: false }),
			]),
			'7d',
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
				from === '2026-12-14' ? json({ error: 'busy' }, 503) : undefined,
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
				from === '2026-12-14'
					? json(
							signupCountsBody(from, to, [
								day('2026-12-20', { 'someone@example.test': 1 }),
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
							...day('2026-12-20', { 'ai-hero': 2 }),
							subscribed: { total: 5, bySource: { 'ai-hero': 2 } },
						},
					]),
				),
		],
		[
			'a different window',
			(from: string, to: string) =>
				json({ ...signupCountsBody(from, to, DAYS), from: '2026-11-20' }),
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
					days: [day('2026-12-21', { kit: 1 })],
				}),
		],
	])('is unavailable on %s', async (_, answer) => {
		const read = await getNewsletterSignups({
			range: '7d',
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
			range: '7d',
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

describe('merging the 7- and 30-day reads day by day', () => {
	it("keeps the 7-day read's days when the 30-day read's newest week fails", async () => {
		const week = await available(fakeDrovr(DAYS), '7d')
		const month = await available(
			fakeDrovr(DAYS, (from) =>
				from === '2026-12-14' ? json({ error: 'busy' }, 503) : undefined,
			),
		)
		expect(month.data.totals.last30!.subscribed.total).toBe(42 + 3)

		const merged = mergeSignupReads(month.data, week.data)
		expect(merged.totals.last30!.subscribed.total).toBe(
			42 + 3 + week.data.totals.last7.subscribed.total,
		)
		expect(merged.totals.last7).toEqual(week.data.totals.last7)
		expect(merged.days.find((d) => d.day === '2026-12-17')!.status).toBe(
			'unavailable',
		)
	})
})

describe('newsletter signups across the Kit-to-drovr seam', () => {
	const seamRead = (range: SignupRange, fetcher = fakeDrovr(SEAM_DROVR_DAYS)) =>
		available(fetcher, range, { env: HISTORY_ENV, now: SEAM_NOW })

	it('reads Kit through 10-29 and drovr from 10-30, never both for one day', async () => {
		const fetcher = fakeDrovr(SEAM_DROVR_DAYS)
		const { data, gaps } = await seamRead('7d', fetcher)

		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			'https://drovr.test/signup-counts?from=2026-10-30&to=2026-11-01',
		])
		expect(gaps).toEqual([])
		expect(
			data.days.map((d) => [
				d.day,
				d.source,
				d.status === 'unavailable' ? null : d.subscribed.total,
			]),
		).toEqual([
			['2026-10-26', 'kit-frozen', 26],
			['2026-10-27', 'kit-frozen', 27],
			['2026-10-28', 'kit-frozen', 28],
			['2026-10-29', 'kit-frozen', 29],
			['2026-10-30', 'drovr', 30],
			['2026-10-31', 'drovr', 31],
			['2026-11-01', 'drovr', 11],
		])
		expect(data.totals.last7.subscribed).toEqual({
			total: 26 + 27 + 28 + 29 + 30 + 31 + 11,
			bySource: { 'kit-frozen': 26 + 27 + 28 + 29, 'ai-hero': 30 + 31 + 11 },
		})
		// Kit days carry no confirmed or unsubscribed counts.
		expect(data.totals.last7.confirmed).toBeNull()
		expect(data.history).toMatchObject({
			status: 'available',
			export: 'kit-export-20261101',
			frozenOn: '2026-11-01',
		})
		expect(data.asOf).toBe('2026-12-20T14:55:00.000Z')
	})

	it('adds the long ranges up by month from the frozen series', async () => {
		const fetcher = fakeDrovr(SEAM_DROVR_DAYS)
		const { data } = await seamRead('all', fetcher)

		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(data).toMatchObject({ from: '2025-08-17', to: '2026-11-01' })
		expect(data.windowDays).toBe(439 + 3)
		const month = (m: string) => data.months.find((x) => x.month === m)!.total
		// Each Kit day reads its day of the month.
		expect(month('2025-08')).toMatchObject({
			days: 15,
			complete: true,
			subscribed: { total: 17 + 18 + 19 + 20 + 21 + 22 + 23 + 24 + 25 + 26 + 27 + 28 + 29 + 30 + 31 },
		})
		expect(month('2026-02').subscribed.total).toBe((28 * 29) / 2)
		expect(month('2026-10').subscribed).toEqual({
			total: (29 * 30) / 2 + 30 + 31,
			bySource: { 'kit-frozen': (29 * 30) / 2, 'ai-hero': 30 + 31 },
		})
		expect(month('2026-11')).toMatchObject({
			partialDays: 1,
			subscribed: { total: 11 },
		})
		expect(data.months).toHaveLength(16)
		expect(data.totals.window.subscribed.total).toBe(6998 + 72)
		expect(
			data.months.reduce((a, m) => a + m.total.subscribed.total, 0),
		).toBe(data.totals.window.subscribed.total)

		const year = (await seamRead('365d')).data
		expect(year.from).toBe('2025-11-02')
		expect(year.windowDays).toBe(365)
		expect(year.totals.window.subscribed.total).toBe(5676 + 72)
	})

	it('asks drovr only for the weeks after the seam that a long range needs', async () => {
		const fetcher = fakeDrovr([])
		const { data } = await available(fetcher, '90d', { env: HISTORY_ENV })

		expect(data.from).toBe('2026-09-22')
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			'https://drovr.test/signup-counts?from=2026-12-14&to=2026-12-20',
			'https://drovr.test/signup-counts?from=2026-12-07&to=2026-12-13',
			'https://drovr.test/signup-counts?from=2026-11-30&to=2026-12-06',
			'https://drovr.test/signup-counts?from=2026-11-23&to=2026-11-29',
			'https://drovr.test/signup-counts?from=2026-11-16&to=2026-11-22',
			'https://drovr.test/signup-counts?from=2026-11-09&to=2026-11-15',
			'https://drovr.test/signup-counts?from=2026-11-02&to=2026-11-08',
			'https://drovr.test/signup-counts?from=2026-10-30&to=2026-11-01',
		])
		// Kit 09-22..09-30 and 10-01..10-29; this drovr has no receipts.
		expect(data.totals.window).toMatchObject({
			reportedDays: 38,
			subscribed: { total: (22 + 30) * 9 / 2 + (29 * 30) / 2 },
		})
	})

	it.each([
		['absent', undefined],
		['not JSON', '{"v":1,'],
		['one day short', kitHistory({ days: Array(438).fill(1) })],
		['a negative count', kitHistory({ days: [-1, ...Array(438).fill(1)] })],
		['a fractional count', kitHistory({ days: [1.5, ...Array(438).fill(1)] })],
		['a moved seam', kitHistory({ seam: '2026-10-30T20:00:00Z' })],
		['a different last day', kitHistory({ to: '2026-10-30' })],
		['another version', kitHistory({ v: 2 })],
		['an extra field', kitHistory({ emails: [] })],
		['an export dated before its last day', kitHistory({ source: 'kit-export-20261001' })],
	])('reads the Kit days unavailable, never 0, when the series is %s', async (_, value) => {
		const { data, gaps } = await available(fakeDrovr(SEAM_DROVR_DAYS), '7d', {
			env: { ...SIGNUP_ENV_ONLY, ...(value ? { AIH_KIT_SIGNUPS_HISTORY_JSON: value } : {}) },
			now: SEAM_NOW,
		})
		expect(data.history).toMatchObject({ status: 'unavailable', export: null })
		expect(gaps).toEqual(['Kit signup history is missing or invalid'])
		expect(data.days.slice(0, 4)).toEqual(
			['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map((day) => ({
				day,
				source: 'kit-frozen',
				status: 'unavailable',
			})),
		)
		expect(data.totals.last7).toMatchObject({
			reportedDays: 3,
			complete: false,
			subscribed: { total: 30 + 31 + 11 },
		})
	})

	it('keeps the Kit days when drovr fails, and is unavailable only when nothing is known', async () => {
		const down = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
		const read = await available(down, '30d', { env: HISTORY_ENV, now: SEAM_NOW })
		expect(read.gaps).toEqual(['drovr signup-counts read failed'])
		expect(read.data.asOf).toBeNull()
		expect(read.data.totals.last30).toMatchObject({ reportedDays: 27 })

		expect(
			await getNewsletterSignups({
				range: '30d',
				env: {},
				fetcher: down,
				now: SEAM_NOW,
			}),
		).toEqual({ status: 'unavailable', reason: 'drovr credentials are not configured' })
	})
})
