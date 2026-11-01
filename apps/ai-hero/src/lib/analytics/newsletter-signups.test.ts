import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	FAKE_SIGNUP_DAYS as DAYS,
	respondWith as respond,
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

async function available(fetcher: ReturnType<typeof respond>) {
	const read = await getNewsletterSignups({ env, fetcher, now })
	if (read.status !== 'available') throw new Error(read.reason)
	return read.data
}

describe('newsletter signups from drovr', () => {
	it('reads the last 30 UTC days with the tenant key, keeping drovr counts', async () => {
		const fetcher = respond(signupCountsBody(DAYS))
		const data = await available(fetcher)

		expect(fetcher).toHaveBeenCalledWith(
			'https://drovr.test/signup-counts?from=2026-10-03&to=2026-11-01',
			expect.objectContaining({
				headers: expect.objectContaining({
					authorization: 'Bearer synthetic-key',
				}),
			}),
		)
		expect(data.days).toHaveLength(30)
		expect(data.days[0]).toEqual({
			day: '2026-10-03',
			status: 'complete',
			subscribed: { total: 42, bySource: { 'ai-hero': 40, kit: 2 } },
			confirmed: 30,
			unsubscribed: 1,
		})
		expect(data.sources).toEqual(['list-import', 'ai-hero', 'kit', 'unknown'])
	})

	it('keeps an absent day unavailable instead of filling it with zero', async () => {
		const data = await available(respond(signupCountsBody(DAYS)))
		expect(data.days.find((d) => d.day === '2026-10-29')).toEqual({
			day: '2026-10-29',
			status: 'unavailable',
		})
		expect(data.totals.last30).toMatchObject({
			days: 30,
			reportedDays: 7,
			complete: false,
		})
	})

	it('draws an incomplete day as partial and says so in the totals', async () => {
		const data = await available(respond(signupCountsBody(DAYS)))
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
		const { last7, last30 } = (await available(respond(signupCountsBody(DAYS))))
			.totals
		// 2026-10-26..2026-11-01, without the absent 2026-10-29.
		expect(last7.subscribed).toEqual({
			total: 101 + 90 + 580 + 71 + 60 + 25,
			bySource: { 'ai-hero': 425, unknown: 1, 'list-import': 500, kit: 1 },
		})
		expect(last7.confirmed).toBe(80 + 70 + 60 + 50 + 40 + 10)
		expect(last7.unsubscribed).toBe(3 + 2 + 0 + 4 + 1 + 0)
		expect(last30.subscribed.total).toBe(last7.subscribed.total + 42)
		expect(
			Object.values(last30.subscribed.bySource).reduce((a, b) => a + b, 0),
		).toBe(last30.subscribed.total)
	})

	it('reports confirmed and unsubscribed as unknown when drovr leaves them out', async () => {
		const data = await available(
			respond(
				signupCountsBody([
					day('2026-10-31', { 'ai-hero': 3 }, { confirmed: 2 }),
					day('2026-11-01', { 'ai-hero': 1 }, { complete: false }),
				]),
			),
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

	it.each([
		['a refused read', () => respond({ error: 'nope' }, 503)],
		[
			'a thrown fetch',
			() => vi.fn().mockRejectedValue(new Error('ECONNRESET')),
		],
		[
			'another tenant',
			() => respond({ ...signupCountsBody(DAYS), tenantId: 'org-other' }),
		],
		[
			'a total that is not the sum of its sources',
			() =>
				respond(
					signupCountsBody([
						{
							...day('2026-11-01', { 'ai-hero': 2 }),
							subscribed: { total: 5, bySource: { 'ai-hero': 2 } },
						},
					]),
				),
		],
		[
			'a source that looks like an address',
			() =>
				respond(
					signupCountsBody([day('2026-11-01', { 'someone@example.test': 1 })]),
				),
		],
		[
			'a different window',
			() => respond({ ...signupCountsBody(DAYS), from: '2026-10-02' }),
		],
		[
			'a duplicated day',
			() => respond(signupCountsBody([DAYS[1]!, DAYS[1]!])),
		],
		[
			'a day outside the window',
			() => respond(signupCountsBody([day('2026-11-02', { kit: 1 })])),
		],
	])('is unavailable on %s', async (_, fetcher) => {
		const read = await getNewsletterSignups({ env, fetcher: fetcher(), now })
		expect(read.status).toBe('unavailable')
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
			env,
			fetcher: fetcher as unknown as typeof fetch,
			now,
		})
		// A cold 30-day read takes about 6 s; it must not be cut off early.
		await vi.advanceTimersByTimeAsync(6_500)
		expect(fetcher.mock.calls[0]![1].signal!.aborted).toBe(false)
		await vi.advanceTimersByTimeAsync(SIGNUP_COUNTS_TIMEOUT_MS - 6_500)
		expect(await pending).toEqual({
			status: 'unavailable',
			reason: 'drovr signup-counts read timed out',
		})
	})
})
