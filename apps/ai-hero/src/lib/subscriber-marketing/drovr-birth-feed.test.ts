import { describe, expect, it, vi } from 'vitest'
import {
	BIRTH_FEED_MAX_CALLS,
	BIRTH_FEED_JOURNEYS,
	BIRTH_FEED_GRACE_MS,
	prepareBirthFeed,
	readDrovrBirths,
	BirthFeedFailure,
	type BirthFeedCheckpoint,
	type BirthFeedPage,
	type BirthFeedRequest,
	type BirthFeedStore,
	type BirthFeedPageRead,
} from './drovr-birth-feed'
import type { OwnerBirthSubject } from './owner-birth-guard'
import type { ContactEventRecord } from './types'
vi.mock('@/env.mjs', () => ({ env: {} }))
const NOW = Date.parse('2026-10-07T16:40:00Z')
const JOURNEY = BIRTH_FEED_JOURNEYS[0]
const empty = (cursor = 'opaque-end'): BirthFeedPage => ({
	births: [],
	asOf: new Date(NOW).toISOString(),
	resumeCursor: cursor,
	nextCursor: null,
})
const config = { baseUrl: 'https://drovr.test/', apiKey: 'test-key' }
const request: BirthFeedRequest = {
	journeyId: JOURNEY,
	since: new Date(NOW - 72 * 3600_000).toISOString(),
	limit: 1000,
}
const row = (id: string, journeyId: string = JOURNEY) => ({
	contactId: id,
	journeyId,
	version: 3,
	bornAt: '2026-10-07T12:00:00Z',
})
function subject(
	id: string,
	eventAt = '2026-10-07T12:00:00Z',
	journeyId: (typeof BIRTH_FEED_JOURNEYS)[number] = JOURNEY,
	birthAt = eventAt,
): OwnerBirthSubject {
	// SAFETY: proof reads only contactId/occurredAt; full guard fixtures cover mapping.
	const owner = {
		id: `owner-${id}`,
		contactId: id,
		occurredAt: eventAt,
	} as ContactEventRecord
	return {
		owner,
		journeyId,
		birth: {
			tenantId: 'org-aihero',
			contactId: id,
			journeyId,
			type: 'contact.created',
			occurredAt: birthAt,
			idempotencyKey: `birth:${id}`,
		},
	}
}
function harness() {
	let clock = NOW
	const checkpoints = new Map<string, BirthFeedCheckpoint>()
	const memberships = new Map<string, Set<string>>()
	const deferred = new Map<string, Set<string>>()
	const requests: BirthFeedRequest[] = []
	const cache = new Map<string, unknown>()
	const step = {
		async run<T>(id: string, operation: () => Promise<T>) {
			if (!cache.has(id))
				cache.set(id, JSON.parse(JSON.stringify(await operation())))
			return cache.get(id)
		},
	}
	let quota = 0
	const store: BirthFeedStore = {
		reserveCall: vi.fn(async () => {
			if (++quota > BIRTH_FEED_MAX_CALLS)
				throw new BirthFeedFailure('page-cap-exceeded')
		}),
		reserveConfirmation: vi.fn(async () => {}),
		deferConfirmation: vi.fn(async (journeyId, ownerId) => {
			const group = deferred.get(journeyId) ?? new Set<string>()
			group.add(ownerId)
			deferred.set(journeyId, group)
		}),
		deferredConfirmations: vi.fn(
			async (journeyId, ownerIds) =>
				new Set(ownerIds.filter((id) => deferred.get(journeyId)?.has(id))),
		),
		observeBorn: vi.fn(async (journeyId, contactId) => {
			memberships.get(journeyId)?.add(contactId)
		}),
		load: vi.fn(async (id) => checkpoints.get(id) ?? null),
		consume: vi.fn(async ({ journeyId, checkpoint, contactIds }) => {
			const seen = memberships.get(journeyId) ?? new Set<string>()
			contactIds.forEach((id) => seen.add(id))
			memberships.set(journeyId, seen)
			checkpoints.set(journeyId, checkpoint)
		}),
		members: vi.fn(
			async ({ journeyId, contactIds }) =>
				new Set(contactIds.filter((id) => memberships.get(journeyId)?.has(id))),
		),
	}
	let answer = (_request: BirthFeedRequest): BirthFeedPage => empty()
	const read = vi.fn(
		async (input: BirthFeedRequest): Promise<BirthFeedPageRead> => {
			requests.push(input)
			return { kind: 'page' as const, page: answer(input) }
		},
	)
	return {
		checkpoints,
		deferred,
		memberships,
		requests,
		store,
		step,
		read,
		answer: (fn: typeof answer) => {
			answer = fn
		},
		run: () =>
			prepareBirthFeed({
				step,
				store,
				read,
				startedAtMs: clock,
				nowMs: () => clock,
				runId: 'fixture-run',
			}),
		newRun: (at = clock) => {
			quota = 0
			cache.clear()
			clock = at
		},
	}
}
describe('GET /births boundary', () => {
	it('uses bearer authority, first since and unchanged opaque cursors without a tenant parameter', async () => {
		const fetcher = vi.fn(
			async () => new Response(JSON.stringify(empty()), { status: 200 }),
		)
		expect((await readDrovrBirths({ request, config, fetcher })).kind).toBe(
			'page',
		)
		await readDrovrBirths({
			request: { journeyId: JOURNEY, cursor: 'opaque/+?&=', limit: 200 },
			config,
			fetcher,
		})
		const [url, init] = fetcher.mock.calls[1] as unknown as [
			string,
			RequestInit,
		]
		expect(new URL(url).searchParams.get('cursor')).toBe('opaque/+?&=')
		expect(new URL(url).searchParams.has('since')).toBe(false)
		expect(new URL(url).searchParams.has('tenantId')).toBe(false)
		expect(init.headers).toMatchObject({ authorization: 'Bearer test-key' })
	})
	it.each([429, 502, 503, 504])(
		'preserves %s before decoding even an absent-looking body',
		async (status) => {
			const response = new Response('not json', {
				status,
				headers: { 'retry-after': '9' },
			})
			const json = vi.spyOn(response, 'json')
			expect(
				await readDrovrBirths({
					request,
					config,
					fetcher: vi.fn(async () => response),
				}),
			).toEqual({ kind: 'shed', backpressure: { status, retryAfter: '9' } })
			expect(json).not.toHaveBeenCalled()
		},
	)
	it('422 fails loudly without depending on provider text', async () => {
		expect(
			await readDrovrBirths({
				request,
				config,
				fetcher: vi.fn(async () => new Response('bad', { status: 422 })),
			}),
		).toEqual({ kind: 'fatal', reason: 'request-refused' })
	})
	it.each([0, 1001, 1.5])(
		'refuses invalid limit %s instead of clamping',
		async (limit) => {
			const fetcher = vi.fn()
			expect(
				(
					await readDrovrBirths({
						request: { ...request, limit },
						config,
						fetcher,
					})
				).kind,
			).toBe('fatal')
			expect(fetcher).not.toHaveBeenCalled()
		},
	)
	it.each([
		{ ...empty(), asOf: 'tomorrow' },
		{ ...empty(), resumeCursor: null },
		{ ...empty(), births: [row('other', BIRTH_FEED_JOURNEYS[1])] },
		{ ...empty(), births: [{ ...row('bad'), version: '3' }] },
		{ ...empty(), births: [{ ...row('bad'), bornAt: 'yesterday' }] },
		{ ...empty(), nextCursor: 'next', resumeCursor: 'different' },
	])('malformed/cross-journey data cannot prove absence', async (body) => {
		expect(
			await readDrovrBirths({
				request,
				config,
				fetcher: vi.fn(async () => new Response(JSON.stringify(body))),
			}),
		).toEqual({ kind: 'fatal', reason: 'invalid-response' })
	})
	it('aborted fetch is shed; other network failures are closed and never thrown inside a read step', async () => {
		expect(
			(
				await readDrovrBirths({
					request,
					config,
					fetcher: vi
						.fn()
						.mockRejectedValue(new DOMException('timeout', 'AbortError')),
				})
			).kind,
		).toBe('shed')
		expect(
			await readDrovrBirths({
				request,
				config,
				fetcher: vi.fn().mockRejectedValue(new Error('sensitive cause')),
			}),
		).toEqual({ kind: 'fatal', reason: 'unavailable' })
	})
})
describe('bounded durable feed preparation', () => {
	it('cooldowns yield unknown, never absence, and positive membership still wins', async () => {
		const h = harness()
		const result = await h.run()
		if (result.kind !== 'ready') throw new Error('fixture not ready')
		const a = subject('a')
		await result.proof.deferConfirmation(JOURNEY, a.owner.id)
		expect((await result.proof.judge([a])).get(a)).toBe('unknown')
		expect(h.store.deferredConfirmations).toHaveBeenCalledWith(JOURNEY, [
			'owner-a',
		])
		await result.proof.observeBorn(JOURNEY, 'a')
		expect((await result.proof.judge([a])).get(a)).toBe('born')
	})
	it('a lost SDK read result spends durable quota again: physical request 11 never starts', async () => {
		const h = harness()
		h.answer(() => ({ ...empty('opaque-next'), nextCursor: 'opaque-next' }))
		const step = {
			async run<T>(id: string, op: () => Promise<T>) {
				if (id.startsWith('birth-feed-read-')) await op() // simulate a lost result
				return op()
			},
		}
		await expect(
			prepareBirthFeed({
				step,
				store: h.store,
				read: h.read,
				startedAtMs: NOW,
				runId: 'lost-result-run',
			}),
		).rejects.toThrow('page-cap-exceeded')
		expect(h.read).toHaveBeenCalledTimes(10)
		expect(h.store.reserveCall).toHaveBeenCalledTimes(11)
	})

	it('never requests page 11, fails loudly and persists only fully consumed pages', async () => {
		const h = harness()
		h.answer(() => {
			const index = h.requests.length
			return {
				...empty(`opaque-${index}`),
				nextCursor: `opaque-${index}`,
				births: [row(`c${index}`)],
			}
		})
		await expect(h.run()).rejects.toThrow('page-cap-exceeded')
		expect(BIRTH_FEED_MAX_CALLS).toBe(10)
		expect(h.read).toHaveBeenCalledTimes(10)
		expect(h.requests.every((r) => r.journeyId === JOURNEY)).toBe(true)
		expect(h.checkpoints.get(JOURNEY)).toMatchObject({
			resumeCursor: 'opaque-10',
			phase: 'paging',
		})
		expect(h.memberships.get(JOURNEY)?.size).toBe(10)
		// Retrying the same SDK run cannot perform another physical GET.
		await expect(h.run()).rejects.toThrow('page-cap-exceeded')
		expect(h.read).toHaveBeenCalledTimes(10)
	})
	it('shares the cap across journeys and accepts exactly ten total pages at EOF', async () => {
		const h = harness()
		let index = 0
		h.answer((input) => ({
			...empty(`page-${++index}`),
			nextCursor:
				input.journeyId === JOURNEY && index < 8 ? `page-${index}` : null,
		}))
		expect(await h.run()).toMatchObject({ kind: 'ready', calls: 10 })
		expect(h.read).toHaveBeenCalledTimes(10)
	})
	it('uses persisted resume on the next hour, retains past membership, and memoizes replay', async () => {
		const h = harness()
		h.answer(() => ({ ...empty('cursor/+'), births: [row('present')] }))
		await h.run()
		await h.run()
		expect(h.read).toHaveBeenCalledTimes(3)
		h.newRun()
		h.answer(() => empty('cursor-2'))
		const next = await h.run()
		expect(h.requests[3]).toEqual({
			journeyId: JOURNEY,
			cursor: 'cursor/+',
			limit: 1000,
		})
		if (next.kind !== 'ready') throw new Error('expected ready')
		const item = subject('present')
		expect((await next.proof.judge([item])).get(item)).toBe('born')
	})
	it('applies grace to the actual newsletter birth, not its weeks-old owner time; null/behind coverage stays unknown', async () => {
		const h = harness()
		const item = subject(
			'n',
			'2026-09-01T00:00:00Z',
			BIRTH_FEED_JOURNEYS[2],
			new Date(NOW - BIRTH_FEED_GRACE_MS + 1).toISOString(),
		)
		const ready = await h.run()
		if (ready.kind !== 'ready') throw new Error('expected ready')
		expect((await ready.proof.judge([item])).get(item)).toBe('unknown')
		const boundary = subject(
			'boundary',
			undefined,
			BIRTH_FEED_JOURNEYS[2],
			new Date(NOW - BIRTH_FEED_GRACE_MS).toISOString(),
		)
		expect((await ready.proof.judge([boundary])).get(boundary)).toBe('missing')
		const older = subject('older', '2026-09-01T00:00:00Z')
		expect((await ready.proof.judge([older])).get(older)).toBe('unknown')
		const n = harness()
		n.answer(() => ({ ...empty(), asOf: null }))
		const unknown = await n.run()
		if (unknown.kind !== 'ready') throw new Error('expected ready')
		const id = subject('absent')
		expect((await unknown.proof.judge([id])).get(id)).toBe('unknown')
	})
	it('projection order is not bornAt order, and presence is journey-scoped', async () => {
		const h = harness()
		h.answer((input) => ({
			...empty(),
			births:
				input.journeyId === JOURNEY
					? [row('x'), { ...row('y'), bornAt: '2026-10-06T00:00:00Z' }]
					: [],
		}))
		const ready = await h.run()
		if (ready.kind !== 'ready') throw new Error('expected ready')
		const present = subject('y'),
			other = subject('x', undefined, BIRTH_FEED_JOURNEYS[1])
		const verdicts = await ready.proof.judge([present, other])
		expect(verdicts.get(present)).toBe('born')
		expect(verdicts.get(other)).toBe('missing')
	})
	it('persists bootstrap since before returning 503; next hour repeats the exact first-page request', async () => {
		const h = harness()
		h.read.mockResolvedValueOnce({
			kind: 'shed',
			backpressure: { status: 503, retryAfter: '10' },
		})
		expect(await h.run()).toMatchObject({ kind: 'shed', calls: 1 })
		const first = h.read.mock.calls[0]![0]
		expect(h.checkpoints.get(JOURNEY)).toMatchObject({
			phase: 'bootstrap',
			since: first.since,
			resumeCursor: null,
			retry: { notBefore: new Date(NOW + 10_000).toISOString() },
		})
		h.newRun(NOW + 3600_000)
		expect(await h.run()).toMatchObject({ kind: 'ready' })
		expect(h.read.mock.calls[1]![0]).toEqual(first)
		expect(h.checkpoints.get(JOURNEY)?.retry).toBeUndefined()
		h.newRun(NOW + 2 * 3600_000)
		await h.run()
		expect(h.read.mock.calls[4]![0]).toEqual({
			journeyId: JOURNEY,
			cursor: 'opaque-end',
			limit: 1000,
		})
	})
	it('cursor-page 503 preserves the exact cursor and consumes no new membership until the retry', async () => {
		const h = harness()
		await h.run()
		const before = h.checkpoints.get(JOURNEY)!
		h.newRun()
		h.read.mockResolvedValueOnce({
			kind: 'shed',
			backpressure: { status: 503, retryAfter: '9' },
		})
		expect(await h.run()).toMatchObject({ kind: 'shed' })
		expect(h.checkpoints.get(JOURNEY)).toMatchObject(before)
		const request = h.read.mock.calls[3]![0]
		expect(request).not.toHaveProperty('since')
		h.newRun(NOW + 3600_000)
		await h.run()
		expect(h.read.mock.calls[4]![0]).toEqual(request)
	})
	it('honors a 24h hold across runs and across journeys, even when wrapper sleep is capped at 50m', async () => {
		const h = harness()
		h.read.mockResolvedValueOnce({ kind: 'page', page: empty() })
		h.read.mockResolvedValueOnce({
			kind: 'shed',
			backpressure: { status: 503, retryAfter: '86400' },
		})
		expect(await h.run()).toMatchObject({ kind: 'shed', calls: 2 })
		const failed = h.read.mock.calls[1]![0]
		h.newRun(NOW + 3600_000)
		expect(await h.run()).toMatchObject({
			kind: 'shed',
			calls: 0,
			backpressure: { status: 503, retryAfter: '82800' },
		})
		expect(h.read).toHaveBeenCalledTimes(2)
		h.newRun(NOW + 86400_000)
		expect(await h.run()).toMatchObject({ kind: 'ready' })
		expect(h.read.mock.calls[3]![0]).toEqual(failed)
	})
	it('a lost SDK shed result repeats neither HTTP nor the deadline write before Retry-After', async () => {
		const h = harness()
		h.read.mockResolvedValueOnce({
			kind: 'shed',
			backpressure: { status: 503, retryAfter: '10' },
		})
		const step = {
			async run<T>(id: string, op: () => Promise<T>) {
				if (id.startsWith('birth-feed-read-')) await op()
				return op()
			},
		}
		expect(
			await prepareBirthFeed({
				step,
				store: h.store,
				read: h.read,
				startedAtMs: NOW,
				runId: 'lost-shed',
				nowMs: () => NOW,
			}),
		).toMatchObject({ kind: 'shed', calls: 1 })
		expect(h.read).toHaveBeenCalledOnce()
		expect(h.store.reserveCall).toHaveBeenCalledOnce()
		expect(h.store.consume).toHaveBeenCalledOnce()
	})
	it('cache loss between the memoized load and physical read cannot rebase a saved request', async () => {
		const h = harness()
		await h.run()
		h.newRun()
		const load = vi.mocked(h.store.load)
		for (const id of BIRTH_FEED_JOURNEYS)
			load.mockResolvedValueOnce(h.checkpoints.get(id)!)
		load.mockResolvedValueOnce(null)
		await expect(h.run()).rejects.toThrow('checkpoint-lost-before-read')
		expect(h.read).toHaveBeenCalledTimes(3)
	})
	it('a failed retry checkpoint write remains terminal and never reaches another read or proof', async () => {
		const h = harness()
		h.read.mockResolvedValueOnce({
			kind: 'shed',
			backpressure: { status: 503, retryAfter: '10' },
		})
		vi.mocked(h.store.consume).mockRejectedValueOnce(
			new BirthFeedFailure('cache-unavailable'),
		)
		await expect(h.run()).rejects.toThrow('cache-unavailable')
		expect(h.read).toHaveBeenCalledOnce()
	})
	it.each([-1, 0, BIRTH_FEED_GRACE_MS - 1, BIRTH_FEED_GRACE_MS])(
		'only own-event-plus-grace coverage can permit a potential miss (offset %s)',
		async (delta) => {
			const h = harness()
			const event = NOW - 2 * 3600_000
			h.answer(() => ({
				...empty(),
				asOf: new Date(event + delta).toISOString(),
			}))
			const ready = await h.run()
			if (ready.kind !== 'ready') throw new Error('fixture not ready')
			const item = subject('watermark', new Date(event).toISOString())
			expect((await ready.proof.judge([item])).get(item)).toBe(
				delta === BIRTH_FEED_GRACE_MS ? 'missing' : 'unknown',
			)
		},
	)
	it('shedding stops before later calls; refusal/network exceptions become terminal, not retrying read steps', async () => {
		const h = harness()
		h.read.mockResolvedValueOnce({
			kind: 'shed',
			backpressure: { status: 503, retryAfter: '10' },
		})
		expect(await h.run()).toMatchObject({ kind: 'shed', calls: 1 })
		expect(h.store.consume).toHaveBeenCalledWith(
			expect.objectContaining({
				contactIds: [],
				checkpoint: expect.objectContaining({
					phase: 'bootstrap',
					resumeCursor: null,
				}),
			}),
		)
		expect(h.read).toHaveBeenCalledOnce()
		const f = harness()
		f.read.mockRejectedValueOnce(new Error('private transport cause'))
		await expect(f.run()).rejects.toBeInstanceOf(BirthFeedFailure)
		await expect(f.run()).rejects.toThrow('unavailable')
		expect(f.read).toHaveBeenCalledOnce()
	})
	it('cache failures cannot produce proof or advance a cursor, and watermark regressions fail closed', async () => {
		const h = harness()
		h.store.consume = vi.fn(async () => {
			throw new BirthFeedFailure('cache-unavailable')
		})
		await expect(h.run()).rejects.toThrow('cache-unavailable')
		expect(h.checkpoints.size).toBe(0)
		const r = harness()
		await r.run()
		r.newRun()
		r.answer(() => ({ ...empty(), asOf: '2026-10-01T00:00:00Z' }))
		await expect(r.run()).rejects.toThrow('watermark-regressed')
	})
})
