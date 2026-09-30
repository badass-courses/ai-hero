import { describe, expect, it } from 'vitest'

import {
	createdDaySlices,
	createKitReader,
	fetchKitMemberIdsInSlices,
	fetchKitSubscriberTagIds,
	KIT_READER_MAX_CONCURRENT,
	KIT_READER_MAX_RETRY_AFTER_MS,
	KIT_READER_MIN_START_INTERVAL_MS,
	KIT_READER_THROTTLE_ATTEMPTS,
	KitReadUnavailableError,
	retryAfterMs,
} from './signup-confirmation-kit-reader'

const DAY = 24 * 60 * 60 * 1000

/**
 * A fake clock: a sleep wakes at its own instant, earliest first, and moves
 * the clock there, so pacing is measured, not waited.
 */
function clock(start = Date.parse('2026-09-30T06:00:00.000Z')) {
	let now = start
	const sleeps: number[] = []
	const pending: Array<{ at: number; wake: () => void }> = []
	let draining = false
	const drain = () => {
		draining = false
		pending.sort((left, right) => left.at - right.at)
		const next = pending.shift()
		if (!next) return
		now = Math.max(now, next.at)
		next.wake()
		draining = true
		setTimeout(drain, 0)
	}
	return {
		now: () => now,
		sleep: (milliseconds: number) =>
			new Promise<void>((wake) => {
				sleeps.push(milliseconds)
				pending.push({ at: now + milliseconds, wake })
				if (!draining) {
					draining = true
					setTimeout(drain, 0)
				}
			}),
		sleeps,
	}
}

const page = (ids: number[], next?: string) =>
	Response.json({
		subscribers: ids.map((id) => ({ id })),
		pagination: { has_next_page: Boolean(next), end_cursor: next ?? null },
	})

describe('the Kit reader keeps well under Kit’s limit (row 211, the hawk)', () => {
	it('starts at most 40 requests a minute and runs at most 4 at once', async () => {
		const time = clock()
		const starts: number[] = []
		let inFlight = 0
		let maxInFlight = 0
		const reader = createKitReader('key', {
			...time,
			fetch: (async () => {
				starts.push(time.now())
				inFlight += 1
				maxInFlight = Math.max(maxInFlight, inFlight)
				// A slow page, as Kit's 1000-row pages are (~10 s).
				await time.sleep(10_000)
				inFlight -= 1
				return page([])
			}) as typeof fetch,
		})
		await Promise.all(
			Array.from({ length: 12 }, () => reader.get('tags/1/subscribers', {})),
		)
		expect(maxInFlight).toBe(KIT_READER_MAX_CONCURRENT)
		for (let index = 1; index < starts.length; index++)
			expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(
				KIT_READER_MIN_START_INTERVAL_MS,
			)
		expect(60_000 / KIT_READER_MIN_START_INTERVAL_MS).toBe(40)
		expect(reader.stats()).toEqual({ calls: 12, throttled: 0 })
	})

	it('settle waits out the pace, so the next step’s first request keeps it', async () => {
		const time = clock()
		const reader = createKitReader('key', {
			...time,
			fetch: (async () => page([])) as typeof fetch,
		})
		const start = time.now()
		await reader.get('tags/1/subscribers', {})
		await reader.settle()
		expect(time.now() - start).toBe(KIT_READER_MIN_START_INTERVAL_MS)
	})

	it('honours a 429’s Retry-After for every request, then reads on', async () => {
		const time = clock()
		const starts: Array<[string, number]> = []
		let throttled = false
		const reader = createKitReader('key', {
			...time,
			fetch: (async (url: URL) => {
				starts.push([url.pathname, time.now()])
				if (url.pathname.endsWith('/a') && !throttled) {
					throttled = true
					return new Response('slow down', {
						status: 429,
						headers: { 'retry-after': '7' },
					})
				}
				return page([])
			}) as typeof fetch,
		})
		const t0 = time.now()
		const [a, b] = await Promise.all([reader.get('a', {}), reader.get('b', {})])
		expect([a.status, b.status]).toEqual([200, 200])
		expect(reader.stats()).toEqual({ calls: 3, throttled: 1 })
		// a's retry waits the 7 s out, and so does b, whose start slot was
		// reserved before the 429 came back (Macroscope 4143156056).
		const retry = starts.filter(([path]) => path.endsWith('/a'))[1]!
		expect(retry[1] - t0).toBeGreaterThanOrEqual(7_000)
		const bStart = starts.find(([path]) => path.endsWith('/b'))!
		expect(bStart[1] - t0).toBeGreaterThanOrEqual(7_000)
	})

	it('holds every later request of the reader until the Retry-After has passed, not only the throttled one', async () => {
		const time = clock()
		const starts: Array<[string, number]> = []
		let later: Promise<Response> | undefined
		const reader = createKitReader('key', {
			...time,
			fetch: (async (url: URL) => {
				starts.push([url.pathname, time.now()])
				if (starts.length === 1) {
					// Another request asks right after Kit throttled the key.
					setTimeout(() => {
						later = reader.get('b', {})
					}, 0)
					return new Response('', {
						status: 429,
						headers: { 'retry-after': '7' },
					})
				}
				return page([])
			}) as typeof fetch,
		})
		const t0 = time.now()
		await reader.get('a', {})
		await later
		const b = starts.find(([path]) => path.endsWith('/b'))!
		expect(b[1] - t0).toBeGreaterThanOrEqual(7_000)
	})

	it('reads Retry-After as seconds or an HTTP date, and caps it at 60 s', async () => {
		const now = Date.parse('2026-09-30T06:00:00.000Z')
		expect(retryAfterMs('12', now)).toBe(12_000)
		expect(retryAfterMs('Wed, 30 Sep 2026 06:00:30 GMT', now)).toBe(30_000)
		expect(retryAfterMs('soon', now)).toBeUndefined()
		expect(retryAfterMs(null, now)).toBeUndefined()

		const time = clock(now)
		let calls = 0
		const reader = createKitReader('key', {
			...time,
			fetch: (async () =>
				calls++ === 0
					? new Response('', {
							status: 429,
							headers: { 'retry-after': '3600' },
						})
					: page([])) as typeof fetch,
		})
		await reader.get('a', {})
		expect(Math.max(...time.sleeps)).toBe(KIT_READER_MAX_RETRY_AFTER_MS)
	})

	it('fails closed when Kit still answers 429 after the backoff', async () => {
		const time = clock()
		const reader = createKitReader('key', {
			...time,
			fetch: (async () => new Response('', { status: 429 })) as typeof fetch,
		})
		const read = reader.get('subscribers/1/tags', {})
		await expect(read).rejects.toBeInstanceOf(KitReadUnavailableError)
		await expect(read).rejects.toMatchObject({ statusCode: 429 })
		expect(reader.stats()).toEqual({
			calls: KIT_READER_THROTTLE_ATTEMPTS,
			throttled: KIT_READER_THROTTLE_ATTEMPTS,
		})
	})

	it('retries a 5xx or no answer three times, then fails closed; hands any other 4xx back', async () => {
		const time = clock()
		const failing = createKitReader('key', {
			...time,
			fetch: (async () => {
				throw new Error('socket hang up')
			}) as typeof fetch,
		})
		await expect(failing.get('a', {})).rejects.toThrow('no answer after 3')
		const down = createKitReader('key', {
			...time,
			fetch: (async () => new Response('', { status: 502 })) as typeof fetch,
		})
		await expect(down.get('a', {})).rejects.toThrow('HTTP 502 after 3')
		const refused = createKitReader('key', {
			...time,
			fetch: (async () => new Response('', { status: 403 })) as typeof fetch,
		})
		expect((await refused.get('a', {})).status).toBe(403)
		expect(refused.stats().calls).toBe(1)
	})
})

describe('the email 0 slices (row 211, the owner’s test a)', () => {
	const at = (iso: string) => Date.parse(iso)

	it('covers each subscriber’s creation day, padded a day each side, in half-open slices that meet exactly', () => {
		const created = [
			'2026-09-30T23:59:59.000Z',
			'2026-09-30T00:00:00.000Z',
			'2026-10-02T12:00:00.000Z',
			'2024-03-02T08:00:00.000Z',
		]
		const slices = createdDaySlices(created)
		expect(slices).toEqual([
			{ after: '2024-03-01T00:00:00.000Z', before: '2024-03-04T00:00:00.000Z' },
			// 09-30 and 10-02 pad into one range, 09-29 to 10-04.
			{ after: '2026-09-29T00:00:00.000Z', before: '2026-10-04T00:00:00.000Z' },
		])
		for (const instant of created)
			expect(
				slices.filter(
					(slice) =>
						at(slice.after) <= at(instant) && at(instant) < at(slice.before),
				),
			).toHaveLength(1)
	})

	it('splits a long range into slices of at most 7 days, each starting where the last ended: no gap, no overlap', () => {
		const created = Array.from({ length: 20 }, (_, day) =>
			new Date(at('2026-09-25T10:00:00.000Z') + day * DAY).toISOString(),
		)
		const slices = createdDaySlices(created)
		expect(slices.length).toBe(4)
		expect(slices[0]!.after).toBe('2026-09-24T00:00:00.000Z')
		expect(slices.at(-1)!.before).toBe('2026-10-16T00:00:00.000Z')
		for (let index = 1; index < slices.length; index++)
			expect(slices[index]!.after).toBe(slices[index - 1]!.before)
		for (const slice of slices)
			expect(at(slice.before) - at(slice.after)).toBeLessThanOrEqual(7 * DAY)
		// Every second of the range is in exactly one slice.
		for (
			let instant = at('2026-09-24T00:00:00.000Z');
			instant < at('2026-10-16T00:00:00.000Z');
			instant += 3_607_000
		)
			expect(
				slices.filter(
					(slice) => at(slice.after) <= instant && instant < at(slice.before),
				),
			).toHaveLength(1)
	})

	it('refuses a subscriber whose creation time does not parse', () => {
		expect(() => createdDaySlices(['not a date'])).toThrow(
			KitReadUnavailableError,
		)
	})

	/**
	 * Kit's filters as measured on 2026-09-30 (a read-only probe of email 0's
	 * team sequence): `created_after` inclusive, `created_before` exclusive,
	 * to the second. `inclusiveBefore` plays a Kit that includes both edges.
	 */
	function sequenceKit(
		members: Array<{ id: number; createdAt: string }>,
		options: { inclusiveBefore?: boolean; pageSize?: number } = {},
	) {
		const requests: URL[] = []
		const fetcher = (async (url: URL) => {
			requests.push(url)
			const after = at(url.searchParams.get('created_after')!)
			const before = at(url.searchParams.get('created_before')!)
			const inSlice = members.filter(({ createdAt }) => {
				const created = at(createdAt)
				return (
					created >= after &&
					(options.inclusiveBefore ? created <= before : created < before)
				)
			})
			const size = options.pageSize ?? 1000
			const offset = Number(url.searchParams.get('after') ?? 0)
			const rows = inSlice.slice(offset, offset + size)
			return page(
				rows.map(({ id }) => id),
				offset + size < inSlice.length ? String(offset + size) : undefined,
			)
		}) as typeof fetch
		return { fetcher, requests }
	}

	it.each([
		['Kit’s measured edges', false],
		['a Kit that includes both edges', true],
	])(
		'finds every member in the slices once, one created exactly on a slice boundary included (%s)',
		async (_, inclusiveBefore) => {
			const created = Array.from({ length: 20 }, (_, day) =>
				new Date(at('2026-09-25T10:00:00.000Z') + day * DAY).toISOString(),
			)
			const slices = createdDaySlices(created)
			const boundary = slices[1]!.after
			const members = [
				{ id: 1, createdAt: created[0]! },
				{ id: 2, createdAt: boundary },
				{ id: 3, createdAt: created.at(-1)! },
				// Outside every slice: never asked for.
				{ id: 4, createdAt: '2026-01-01T00:00:00.000Z' },
				...Array.from({ length: 5 }, (_, index) => ({
					id: 100 + index,
					createdAt: created[3]!,
				})),
			]
			const kit = sequenceKit(members, { inclusiveBefore, pageSize: 2 })
			const reader = createKitReader('key', {
				...clock(),
				fetch: kit.fetcher,
			})
			const ids = await fetchKitMemberIdsInSlices(
				reader,
				['sequences/2757199'],
				slices,
			)
			expect([...ids].sort()).toEqual(
				['1', '2', '3', '100', '101', '102', '103', '104'].sort(),
			)
			// Each slice asked with Kit's half-open edges, all states.
			expect(
				kit.requests
					.filter((url) => !url.searchParams.has('after'))
					.map((url) => [
						url.searchParams.get('created_after'),
						url.searchParams.get('created_before'),
						url.searchParams.get('status'),
					]),
			).toEqual(slices.map((slice) => [slice.after, slice.before, 'all']))
		},
	)

	it('fails the whole read closed when one slice fails, and the other slices stop paging (the owner’s test b)', async () => {
		const created = Array.from({ length: 20 }, (_, day) =>
			new Date(at('2026-09-25T10:00:00.000Z') + day * DAY).toISOString(),
		)
		const slices = createdDaySlices(created)
		let requests = 0
		const reader = createKitReader('key', {
			...clock(),
			fetch: (async (url: URL) => {
				requests += 1
				if (url.searchParams.get('created_after') === slices[2]!.after)
					return Response.json({ error: 'nope' }, { status: 403 })
				return page([requests], String(requests))
			}) as typeof fetch,
		})
		await expect(
			fetchKitMemberIdsInSlices(reader, ['sequences/2757199'], slices),
		).rejects.toBeInstanceOf(KitReadUnavailableError)
		// The endless pages of the other slices stop once one failed, and
		// stay stopped.
		await new Promise((resolve) => setTimeout(resolve, 100))
		expect(requests).toBeLessThan(20)
	})

	it('never sends a queued or waiting slice read once another slice failed (Macroscope 4143156021)', async () => {
		// Eight slices, four at a time: the first read fails, and none of the
		// other seven, reserved or queued, reaches Kit.
		const slices = createdDaySlices(
			Array.from({ length: 8 }, (_, index) =>
				new Date(
					at('2026-06-01T10:00:00.000Z') + index * 10 * DAY,
				).toISOString(),
			),
		)
		expect(slices).toHaveLength(8)
		let requests = 0
		const reader = createKitReader('key', {
			...clock(),
			fetch: (async () => {
				requests += 1
				return Response.json({ error: 'nope' }, { status: 403 })
			}) as typeof fetch,
		})
		await expect(
			fetchKitMemberIdsInSlices(reader, ['sequences/2757199'], slices),
		).rejects.toBeInstanceOf(KitReadUnavailableError)
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(requests).toBe(1)
		expect(reader.stats().calls).toBe(1)
	})

	it.each([
		['a malformed page', () => Response.json({ subscribers: [{ id: 'x' }] })],
		// An empty cursor is refused by the page schema; the null cursor has
		// its own test below.
		['an empty cursor', () => page([1], '')],
		['a body that is not JSON', () => new Response('<html>')],
	])('fails a slice closed on %s', async (_, answer) => {
		const reader = createKitReader('key', {
			...clock(),
			fetch: (async () => answer()) as typeof fetch,
		})
		await expect(
			fetchKitMemberIdsInSlices(
				reader,
				['sequences/2757199'],
				createdDaySlices(['2026-09-30T10:00:00.000Z']),
			),
		).rejects.toBeInstanceOf(KitReadUnavailableError)
	})
})

describe("one subscriber's tags", () => {
	const tags = (ids: number[], next?: string) =>
		Response.json({
			tags: ids.map((id) => ({ id, name: `t${id}`, tagged_at: 'x' })),
			pagination: { has_next_page: Boolean(next), end_cursor: next ?? null },
		})

	it('reads every page of the tags', async () => {
		const reader = createKitReader('key', {
			...clock(),
			fetch: (async (url: URL) =>
				url.searchParams.get('after')
					? tags([8244351])
					: tags([1, 2], 'c1')) as typeof fetch,
		})
		expect(await fetchKitSubscriberTagIds(reader, '42')).toEqual(
			new Set(['1', '2', '8244351']),
		)
	})

	it('answers not-found for a subscriber Kit no longer has, and throws on any other failure', async () => {
		const answer = (status: number) =>
			createKitReader('key', {
				...clock(),
				fetch: (async () => new Response('', { status })) as typeof fetch,
			})
		expect(await fetchKitSubscriberTagIds(answer(404), '42')).toBe('not-found')
		await expect(fetchKitSubscriberTagIds(answer(403), '42')).rejects.toThrow(
			KitReadUnavailableError,
		)
		await expect(fetchKitSubscriberTagIds(answer(500), '42')).rejects.toThrow(
			KitReadUnavailableError,
		)
		const malformed = createKitReader('key', {
			...clock(),
			fetch: (async () => Response.json({ tags: 'nope' })) as typeof fetch,
		})
		await expect(fetchKitSubscriberTagIds(malformed, '42')).rejects.toThrow(
			KitReadUnavailableError,
		)
	})
})

describe('pagers fail closed at their edges (Sonnet 2’s gaps, adopted)', () => {
	const fast = (fetcher: typeof fetch) =>
		createKitReader('key', {
			fetch: fetcher,
			sleep: async () => {},
			minStartIntervalMs: 0,
		})
	const oneSlice = createdDaySlices(['2026-09-30T10:00:00.000Z'])

	it('a slice page with a next page but a null cursor: a truncated email 0 list must never read as complete', async () => {
		await expect(
			fetchKitMemberIdsInSlices(
				fast((async () =>
					Response.json({
						subscribers: [{ id: 1 }],
						pagination: { has_next_page: true, end_cursor: null },
					})) as typeof fetch),
				['sequences/2757199'],
				oneSlice,
			),
		).rejects.toThrow('next page without a cursor')
	})

	it('a slice pager that never ends fails at the cap', async () => {
		let n = 0
		await expect(
			fetchKitMemberIdsInSlices(
				fast((async () => page([++n], String(n))) as typeof fetch),
				['sequences/2757199'],
				oneSlice,
			),
		).rejects.toThrow('more than 100 pages')
	})

	it('a tags page with a next page but a null cursor: a missed unsubscribe tag on page 2 must never read as none', async () => {
		await expect(
			fetchKitSubscriberTagIds(
				fast((async () =>
					Response.json({
						tags: [{ id: 1 }],
						pagination: { has_next_page: true, end_cursor: null },
					})) as typeof fetch),
				'5',
			),
		).rejects.toThrow('next page without a cursor')
	})

	it('a tags pager that never ends fails at the cap', async () => {
		let n = 0
		await expect(
			fetchKitSubscriberTagIds(
				fast((async () =>
					Response.json({
						tags: [{ id: ++n }],
						pagination: { has_next_page: true, end_cursor: String(n) },
					})) as typeof fetch),
				'5',
			),
		).rejects.toThrow('more than 20 pages')
	})
})
