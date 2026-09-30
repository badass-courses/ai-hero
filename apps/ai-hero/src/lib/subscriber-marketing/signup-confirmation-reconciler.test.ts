import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KIT_READER_MIN_START_INTERVAL_MS } from './signup-confirmation-kit-reader'
import {
	checkSkillsConfirmationTags,
	reconcileSkillsConfirmations,
	ReconcilerEvidenceUnavailableError,
	SKILLS_CONFIRMATION_RECENT_TIER_DAYS,
	SKILLS_CONFIRMATION_EMAIL_ZERO_SLICE_LIMIT,
	SKILLS_CONFIRMATION_TAG_CHECKS_PER_RUN,
	SKILLS_CONFIRMATION_TAG_SLICE_LIMIT,
	scanSkillsConfirmations,
	SKILLS_NEWSLETTER_FORM_ID,
	type SkillsConfirmationEvent,
	type SkillsConfirmationTier,
} from './signup-confirmation-reconciler.server'

// Row 211: the reconciler's run shape against a fake Kit. Local evidence is
// empty here (every query answers no rows); the MySQL suite covers it.
const TO = '2026-10-20T06:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000
const daysBefore = (days: number, minutes = 0) =>
	new Date(Date.parse(TO) - days * DAY - minutes * 60_000).toISOString()

/** A Drizzle stand-in whose every query resolves to no rows. */
function emptyDatabase() {
	const chain: unknown = new Proxy(() => chain, {
		get: (_, property) =>
			property === 'then'
				? (resolve: (rows: unknown[]) => void) => resolve([])
				: () => chain,
	})
	return { select: () => chain } as never
}

type FakeSubscriber = {
	id: number
	state?: 'active' | 'inactive'
	createdAt: string
	addedAt: string
	tags?: number[]
	sequences?: string[]
}

/**
 * Kit's form, sequence, tag and subscriber-tags reads, with the edges
 * measured on 2026-09-30: `created_after` inclusive, `created_before`
 * exclusive.
 */
function fakeKit(
	subscribers: FakeSubscriber[],
	override?: (url: URL) => Response | undefined,
) {
	const requests: URL[] = []
	const fetcher = (async (input: URL) => {
		const url = new URL(String(input))
		requests.push(url)
		const overridden = override?.(url)
		if (overridden) return overridden
		const form = /\/v4\/forms\/\d+\/subscribers$/.test(url.pathname)
		const sequence = /\/v4\/sequences\/(\d+)\/subscribers$/.exec(
			url.pathname,
		)?.[1]
		const tagsOf = /\/v4\/subscribers\/(\d+)\/tags$/.exec(url.pathname)?.[1]
		if (tagsOf) {
			const subscriber = subscribers.find(({ id }) => String(id) === tagsOf)
			if (!subscriber) return Response.json({}, { status: 404 })
			return Response.json({
				tags: (subscriber.tags ?? []).map((id) => ({
					id,
					name: `tag ${id}`,
					tagged_at: subscriber.addedAt,
				})),
				pagination: { has_next_page: false, end_cursor: null },
			})
		}
		const tag = /\/v4\/tags\/(\d+)\/subscribers$/.exec(url.pathname)?.[1]
		if (sequence || tag) {
			// No created filters: the whole list.
			const after = Date.parse(
				url.searchParams.get('created_after') ?? '1970-01-01T00:00:00Z',
			)
			const before = Date.parse(
				url.searchParams.get('created_before') ?? '9999-01-01T00:00:00Z',
			)
			return Response.json({
				subscribers: subscribers
					.filter(
						(subscriber) =>
							(sequence
								? subscriber.sequences?.includes(sequence)
								: subscriber.tags?.includes(Number(tag))) &&
							Date.parse(subscriber.createdAt) >= after &&
							Date.parse(subscriber.createdAt) < before,
					)
					.map(({ id }) => ({ id })),
				pagination: { has_next_page: false, end_cursor: null },
			})
		}
		if (form) {
			const addedAfter = Date.parse(url.searchParams.get('added_after')!)
			return Response.json({
				subscribers: subscribers
					.filter(
						(subscriber) =>
							(subscriber.state ?? 'active') ===
								url.searchParams.get('status') &&
							Date.parse(subscriber.addedAt) >= addedAfter,
					)
					.map((subscriber) => ({
						id: subscriber.id,
						email_address: `learner-${subscriber.id}@example.test`,
						state: subscriber.state ?? 'active',
						created_at: subscriber.createdAt,
						added_at: subscriber.addedAt,
						fields: {},
					})),
				pagination: { has_next_page: false, end_cursor: null },
			})
		}
		return Response.json({ error: 'unexpected' }, { status: 400 })
	}) as typeof fetch
	return { fetcher, requests }
}

function run(
	tier: SkillsConfirmationTier,
	kit: ReturnType<typeof fakeKit>,
	options: {
		limit?: number
		sleeps?: number[]
		onTagCheckFailed?: (failure: {
			kitSubscriberId: string
			reason: string
		}) => void
	} = {},
) {
	const stepIds: string[] = []
	const sent: Array<{ id: string; event: SkillsConfirmationEvent }> = []
	let clockMs = Date.parse(TO)
	const receipt = reconcileSkillsConfirmations({
		tier,
		to: TO,
		limit: options.limit ?? 50,
		database: emptyDatabase(),
		onTagCheckFailed: options.onTagCheckFailed,
		kit: {
			fetch: kit.fetcher,
			// A fake clock: sleeping moves it, so pacing is never waited.
			now: () => clockMs,
			sleep: async (milliseconds) => {
				options.sleeps?.push(milliseconds)
				clockMs += milliseconds
			},
		},
		steps: {
			run: async (id, work) => {
				stepIds.push(id)
				return JSON.parse(JSON.stringify(await work()))
			},
			send: async (id, event) => {
				stepIds.push(id)
				sent.push({ id, event })
			},
		},
	})
	return { receipt, stepIds, sent }
}

const sentIds = (sent: Array<{ event: SkillsConfirmationEvent }>) =>
	sent.map(({ event }) => event.data.kitSubscriberId)

const kitPaths = (kit: ReturnType<typeof fakeKit>) =>
	kit.requests.map((url) => url.pathname.replace('/v4/', ''))

beforeEach(() => {
	vi.stubEnv('CONVERTKIT_V4_API_KEY', 'test-kit-key')
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('row 211: the scan is tiered, never capped by age', () => {
	it('births a learner who confirms on day 20 by the daily tier; the recent tier leaves them', async () => {
		const kit = fakeKit([
			{ id: 20, createdAt: daysBefore(20), addedAt: daysBefore(20) },
		])

		const recent = run('recent', kit)
		expect((await recent.receipt).window).toEqual({
			from: daysBefore(SKILLS_CONFIRMATION_RECENT_TIER_DAYS),
			to: TO,
		})
		expect(recent.sent).toEqual([])

		const daily = run('daily', kit)
		const receipt = await daily.receipt
		expect(receipt.window.from).toBe('2026-09-25T00:00:00.000Z')
		expect(sentIds(daily.sent)).toEqual(['20'])
		expect(receipt).toMatchObject({
			tier: 'daily',
			counts: { planned: 1, plannedOlderThanRecentTier: 1 },
		})
	})

	it('enters a recent confirmer on every poll, and the daily tier counts them as recent', async () => {
		const kit = fakeKit([
			{ id: 1, createdAt: daysBefore(0, 30), addedAt: daysBefore(0, 30) },
		])
		const recent = run('recent', kit)
		await recent.receipt
		expect(sentIds(recent.sent)).toEqual(['1'])
		const daily = run('daily', kit)
		expect((await daily.receipt).counts.plannedOlderThanRecentTier).toBe(0)
	})
})

describe('row 211: each confirmed subscriber is sent as found', () => {
	const three = () =>
		fakeKit([
			{ id: 1, createdAt: daysBefore(0, 10), addedAt: daysBefore(0, 10) },
			{ id: 2, createdAt: daysBefore(0, 20), addedAt: daysBefore(0, 20) },
			{ id: 3, createdAt: daysBefore(0, 30), addedAt: daysBefore(0, 30) },
		])

	it('sends each in its own step, newest first, right after its own tag check', async () => {
		const { receipt, stepIds } = run('recent', three())
		await receipt
		expect(stepIds).toEqual([
			'scan-confirmation-candidates',
			'check-opt-out-tags:1',
			'enqueue-confirmed-subscriber:1',
			'check-opt-out-tags:2',
			'enqueue-confirmed-subscriber:2',
			'check-opt-out-tags:3',
			'enqueue-confirmed-subscriber:3',
		])
	})

	it('never doubles on a rerun: the same event ids and step ids, each sent once a run', async () => {
		const kit = three()
		const first = run('recent', kit)
		await first.receipt
		const second = run('recent', kit)
		await second.receipt
		const ids = (sent: typeof first.sent) =>
			sent.map(({ id, event }) => [id, event.id])
		expect(ids(first.sent)).toEqual([
			[
				'enqueue-confirmed-subscriber:1',
				`skills-confirmed:${SKILLS_NEWSLETTER_FORM_ID}:1`,
			],
			[
				'enqueue-confirmed-subscriber:2',
				`skills-confirmed:${SKILLS_NEWSLETTER_FORM_ID}:2`,
			],
			[
				'enqueue-confirmed-subscriber:3',
				`skills-confirmed:${SKILLS_NEWSLETTER_FORM_ID}:3`,
			],
		])
		expect(ids(second.sent)).toEqual(ids(first.sent))
		// The daily tier overlaps the recent one with the same keys.
		const daily = run('daily', kit)
		await daily.receipt
		expect(ids(daily.sent)).toEqual(ids(first.sent))
	})

	it('counts sends, not checks, against the limit: a candidate skipped at its check does not use a send', async () => {
		const kit = fakeKit(
			[
				{ id: 1, createdAt: daysBefore(0, 10), addedAt: daysBefore(0, 10) },
				{ id: 2, createdAt: daysBefore(0, 20), addedAt: daysBefore(0, 20) },
				{ id: 3, createdAt: daysBefore(0, 30), addedAt: daysBefore(0, 30) },
			],
			(url) =>
				url.pathname === '/v4/subscribers/1/tags'
					? Response.json({}, { status: 404 })
					: undefined,
		)
		const { receipt, sent } = run('recent', kit, { limit: 1 })
		expect((await receipt).counts).toMatchObject({
			tagChecked: 2,
			notInKit: 1,
			planned: 1,
			deferred: 1,
		})
		expect(sentIds(sent)).toEqual(['2'])
	})

	it('checks at most 100 candidates a run, so skipped ones can’t outgrow the run', async () => {
		expect(SKILLS_CONFIRMATION_TAG_CHECKS_PER_RUN).toBe(100)
		// 105 candidates Kit answers 404 for at their check: only the cap
		// ends the loop.
		const kit = fakeKit(
			Array.from({ length: 105 }, (_, index) => ({
				id: index + 1,
				createdAt: daysBefore(0, index + 1),
				addedAt: daysBefore(0, index + 1),
			})),
			(url) =>
				url.pathname.endsWith('/tags')
					? Response.json({}, { status: 404 })
					: undefined,
		)
		const { receipt, sent } = run('recent', kit)
		expect((await receipt).counts).toMatchObject({
			tagChecked: 100,
			notInKit: 100,
			deferred: 5,
		})
		expect(sent).toEqual([])
	})

	it('never starves a consenting subscriber behind Kit-tag opt-outs: 100 opted out ahead of 1 older consenting, sent on the first poll (Sonnet 2, round 2)', async () => {
		const kit = fakeKit([
			...Array.from({ length: 100 }, (_, index) => ({
				id: index + 1,
				createdAt: daysBefore(0, index + 1),
				addedAt: daysBefore(0, index + 1),
				tags: [index % 2 ? 8244351 : 19251081],
			})),
			{ id: 101, createdAt: daysBefore(0, 200), addedAt: daysBefore(0, 200) },
		])
		const { receipt, sent } = run('recent', kit)
		expect((await receipt).counts).toMatchObject({
			candidates: 1,
			excludedByTag: 100,
			tagChecked: 1,
			planned: 1,
			deferred: 0,
		})
		expect(sentIds(sent)).toEqual(['101'])
	})

	it('stops at the limit and leaves the rest for the next run', async () => {
		const { receipt, sent } = run('recent', three(), { limit: 2 })
		expect(await receipt).toMatchObject({
			counts: { candidates: 3, tagChecked: 2, planned: 2, deferred: 1 },
		})
		expect(sentIds(sent)).toEqual(['1', '2'])
	})
})

describe('row 211: Kit is read only as far as it must be', () => {
	it('reads no Kit list at all when nobody new confirmed: the form, and that is all', async () => {
		const kit = fakeKit([
			{
				id: 7,
				state: 'inactive',
				createdAt: daysBefore(0, 5),
				addedAt: daysBefore(0, 5),
			},
		])
		const receipt = await run('recent', kit).receipt
		expect(kitPaths(kit).every((path) => path.startsWith('forms/'))).toBe(true)
		expect(receipt.kit).toEqual({ calls: 5, throttled: 0 })
		expect(receipt.counts).toMatchObject({ unconfirmed: 1, candidates: 0 })
	})

	it('excludes Kit-tag opt-outs at the scan, by the tags read in the creation-day slices, and still checks each remaining candidate fresh', async () => {
		const kit = fakeKit([
			{ id: 1, createdAt: daysBefore(0, 10), addedAt: daysBefore(0, 10) },
			{
				id: 2,
				createdAt: daysBefore(0, 20),
				addedAt: daysBefore(0, 20),
				tags: [5, 8244351],
			},
			{
				id: 3,
				createdAt: daysBefore(0, 30),
				addedAt: daysBefore(0, 30),
				tags: [19251081],
			},
		])
		const { receipt, sent } = run('recent', kit)
		expect(await receipt).toMatchObject({
			counts: {
				candidates: 1,
				excludedByTag: 2,
				excludedOptedOut: 2,
				tagChecked: 1,
				excludedByFreshTagCheck: 0,
			},
		})
		expect(sentIds(sent)).toEqual(['1'])
		const tagReads = kit.requests.filter((url) =>
			url.pathname.startsWith('/v4/tags/'),
		)
		expect(tagReads.map((url) => url.pathname).sort()).toEqual([
			'/v4/tags/19251081/subscribers',
			'/v4/tags/8244351/subscribers',
		])
		for (const url of tagReads) {
			expect(url.searchParams.get('created_after')).toBe(
				'2026-10-19T00:00:00.000Z',
			)
			expect(url.searchParams.get('created_before')).toBe(
				'2026-10-22T00:00:00.000Z',
			)
			expect(url.searchParams.get('status')).toBe('all')
		}
		expect(
			kitPaths(kit).filter((path) => path.startsWith('subscribers/')),
		).toEqual(['subscribers/1/tags'])
	})

	it('catches a tag applied between the scan and the send by the fresh check', async () => {
		const kit = fakeKit(
			[
				{
					id: 1,
					createdAt: daysBefore(0, 10),
					addedAt: daysBefore(0, 10),
					tags: [8244351],
				},
				{ id: 2, createdAt: daysBefore(0, 20), addedAt: daysBefore(0, 20) },
				{
					id: 3,
					createdAt: daysBefore(0, 30),
					addedAt: daysBefore(0, 30),
					tags: [19251081],
				},
			],
			// At the scan, neither tag is on subscribers 1 and 3 yet.
			(url) =>
				url.pathname.startsWith('/v4/tags/')
					? Response.json({
							subscribers: [],
							pagination: { has_next_page: false, end_cursor: null },
						})
					: undefined,
		)
		const { receipt, sent } = run('recent', kit)
		expect((await receipt).counts).toMatchObject({
			candidates: 3,
			excludedByFreshTagCheck: 2,
			excludedByTag: 0,
			excludedByTagTotal: 2,
			planned: 1,
		})
		expect(sentIds(sent)).toEqual(['2'])
	})

	it('reads email 0 only around the candidates’ creation days, and never sends someone in it', async () => {
		const kit = fakeKit([
			{ id: 1, createdAt: daysBefore(0, 10), addedAt: daysBefore(0, 10) },
			{
				id: 2,
				// An old Kit record, new to the form.
				createdAt: '2025-03-02T08:00:00.000Z',
				addedAt: daysBefore(0, 20),
				sequences: ['2757199'],
			},
		])
		const { receipt, sent } = run('recent', kit)
		expect(await receipt).toMatchObject({
			counts: { candidates: 1, excludedCourseHistory: 1 },
		})
		expect(sentIds(sent)).toEqual(['1'])
		const slices = kit.requests
			.filter((url) => url.pathname.startsWith('/v4/sequences/'))
			.map((url) => [
				url.pathname,
				url.searchParams.get('created_after'),
				url.searchParams.get('created_before'),
			])
		expect(slices).toEqual(
			expect.arrayContaining([
				[
					'/v4/sequences/2757199/subscribers',
					'2025-03-01T00:00:00.000Z',
					'2025-03-04T00:00:00.000Z',
				],
				[
					'/v4/sequences/2757199/subscribers',
					'2026-10-19T00:00:00.000Z',
					'2026-10-22T00:00:00.000Z',
				],
			]),
		)
	})

	it('logs every Kit call of the run, retries and 429s included', async () => {
		let throttledOnce = false
		const kit = fakeKit(
			[{ id: 1, createdAt: daysBefore(0, 10), addedAt: daysBefore(0, 10) }],
			(url) => {
				if (url.pathname.endsWith('/tags') && !throttledOnce) {
					throttledOnce = true
					return new Response('', {
						status: 429,
						headers: { 'retry-after': '2' },
					})
				}
				return undefined
			},
		)
		const sleeps: number[] = []
		const { receipt, sent } = run('recent', kit, { sleeps })
		const { kit: calls } = await receipt
		expect(calls).toEqual({ calls: kit.requests.length, throttled: 1 })
		expect(sleeps).toContain(2_000)
		expect(sentIds(sent)).toEqual(['1'])
	})
})

describe('row 211: no decision on partial evidence', () => {
	const two = (override: (url: URL) => Response | undefined) =>
		fakeKit(
			[
				{ id: 1, createdAt: daysBefore(0, 10), addedAt: daysBefore(0, 10) },
				{ id: 2, createdAt: daysBefore(0, 20), addedAt: daysBefore(0, 20) },
			],
			override,
		)

	it('fails the run closed when an opt-out tag slice fails: nobody is sent', async () => {
		const kit = two((url) =>
			url.pathname === '/v4/tags/19251081/subscribers'
				? Response.json({ error: 'nope' }, { status: 403 })
				: undefined,
		)
		const { receipt, sent } = run('recent', kit)
		await expect(receipt).rejects.toBeInstanceOf(
			ReconcilerEvidenceUnavailableError,
		)
		expect(sent).toEqual([])
	})

	it('fails the run closed when an email 0 slice fails: nobody is sent (the owner’s test b)', async () => {
		const kit = two((url) =>
			url.pathname === '/v4/sequences/2757206/subscribers'
				? Response.json({ error: 'nope' }, { status: 403 })
				: undefined,
		)
		const { receipt, sent } = run('recent', kit)
		await expect(receipt).rejects.toBeInstanceOf(
			ReconcilerEvidenceUnavailableError,
		)
		expect(sent).toEqual([])
	})

	it.each([
		['a 403', () => Response.json({ error: 'nope' }, { status: 403 })],
		['a 5xx after the retries', () => new Response('', { status: 503 })],
		['a malformed answer', () => Response.json({ tags: 'nope' })],
		[
			'a next page without a cursor',
			() =>
				Response.json({
					tags: [],
					pagination: { has_next_page: true, end_cursor: null },
				}),
		],
	])(
		'skips only the candidate whose tag check fails on %s: unsent, counted, and the older ones still go (the owner’s test c, Sonnet 2 S2)',
		async (_, answer) => {
			const failures: Array<{ kitSubscriberId: string; reason: string }> = []
			const kit = two((url) =>
				url.pathname === '/v4/subscribers/1/tags' ? answer() : undefined,
			)
			const { receipt, sent } = run('recent', kit, {
				onTagCheckFailed: (failure) => failures.push(failure),
			})
			expect((await receipt).counts).toMatchObject({
				tagChecked: 2,
				tagFailed: 1,
				planned: 1,
			})
			// The newest failed its check and is never sent; the older one is.
			expect(sentIds(sent)).toEqual(['2'])
			expect(failures.map(({ kitSubscriberId }) => kitSubscriberId)).toEqual([
				'1',
			])
		},
	)

	it('stops the run, closed, on 429 after the backoff: the key is throttled, not the subscriber', async () => {
		const kit = two((url) =>
			url.pathname === '/v4/subscribers/1/tags'
				? new Response('', { status: 429 })
				: undefined,
		)
		const { receipt, sent } = run('recent', kit)
		await expect(receipt).rejects.toBeInstanceOf(
			ReconcilerEvidenceUnavailableError,
		)
		expect(sent).toEqual([])
		// No further candidate was checked.
		expect(
			kitPaths(kit).filter((path) => path === 'subscribers/2/tags'),
		).toEqual([])
	})

	it('stops the run, closed, after 3 tag checks fail in a row: that is Kit, not the subscribers', async () => {
		const kit = fakeKit(
			[1, 2, 3, 4].map((id) => ({
				id,
				createdAt: daysBefore(0, id * 10),
				addedAt: daysBefore(0, id * 10),
			})),
			(url) =>
				url.pathname.endsWith('/tags')
					? new Response('', { status: 502 })
					: undefined,
		)
		const { receipt, sent } = run('recent', kit)
		await expect(receipt).rejects.toThrow('3 tag checks failed in a row')
		expect(sent).toEqual([])
		expect(
			kitPaths(kit).filter((path) => path === 'subscribers/4/tags'),
		).toEqual([])
	})

	it('resets the failures-in-a-row count on a check that answers', async () => {
		const kit = fakeKit(
			[1, 2, 3, 4, 5].map((id) => ({
				id,
				createdAt: daysBefore(0, id * 10),
				addedAt: daysBefore(0, id * 10),
			})),
			(url) =>
				[
					'/v4/subscribers/1/tags',
					'/v4/subscribers/2/tags',
					'/v4/subscribers/4/tags',
					'/v4/subscribers/5/tags',
				].includes(url.pathname)
					? new Response('', { status: 403 })
					: undefined,
		)
		const { receipt, sent } = run('recent', kit)
		expect((await receipt).counts).toMatchObject({ tagFailed: 4, planned: 1 })
		expect(sentIds(sent)).toEqual(['3'])
	})

	it.each([
		[
			'answers',
			() => Response.json({ tags: [], pagination: { has_next_page: false } }),
		],
		['fails', () => Response.json({ error: 'nope' }, { status: 403 })],
	])(
		'keeps the pace when a tag check %s: the step settles before it ends, so the next check waits its turn',
		async (_, answer) => {
			let clockMs = Date.parse(TO)
			const checked = await checkSkillsConfirmationTags({
				kitSubscriberId: '1',
				kit: {
					fetch: (async () => answer()) as typeof fetch,
					now: () => clockMs,
					sleep: async (milliseconds) => {
						clockMs += milliseconds
					},
				},
			})
			expect(checked.kit.calls).toBe(1)
			expect(clockMs - Date.parse(TO)).toBe(KIT_READER_MIN_START_INTERVAL_MS)
		},
	)

	it('skips a subscriber Kit no longer has (404), unsent, and goes on', async () => {
		const kit = two((url) =>
			url.pathname === '/v4/subscribers/1/tags'
				? Response.json({}, { status: 404 })
				: undefined,
		)
		const { receipt, sent } = run('recent', kit)
		expect((await receipt).counts).toMatchObject({ notInKit: 1, planned: 1 })
		expect(sentIds(sent)).toEqual(['2'])
	})

	it('fails the run closed when the form read fails', async () => {
		const kit = two((url) =>
			url.pathname.startsWith('/v4/forms/')
				? new Response('', { status: 429 })
				: undefined,
		)
		const { receipt, sent } = run('recent', kit)
		await expect(receipt).rejects.toBeInstanceOf(
			ReconcilerEvidenceUnavailableError,
		)
		expect(sent).toEqual([])
	})
})

describe('row 211: the form read fails closed (Sonnet 2’s gaps, adopted)', () => {
	const scan = (answer: () => Response) =>
		scanSkillsConfirmations({
			tier: 'recent',
			to: TO,
			database: emptyDatabase(),
			kit: {
				fetch: (async () => answer()) as typeof fetch,
				sleep: async () => {},
				minStartIntervalMs: 0,
			},
		})

	it.each([
		['a 403', () => Response.json({ error: 'no' }, { status: 403 })],
		['a body that is not JSON', () => new Response('<html>')],
		[
			'a pager that never ends',
			() =>
				Response.json({
					subscribers: [],
					pagination: { has_next_page: true, end_cursor: 'c' },
				}),
		],
		[
			'a next page without a cursor (a short list, before)',
			() =>
				Response.json({
					subscribers: [],
					pagination: { has_next_page: true, end_cursor: null },
				}),
		],
	])('fails the scan on %s', async (_, answer) => {
		await expect(scan(answer)).rejects.toBeInstanceOf(
			ReconcilerEvidenceUnavailableError,
		)
	})
})

describe('row 211 round 3: opt-outs and old records cost a bounded amount of Kit', () => {
	/** Candidates whose Kit records were created 10 days apart, newest first. */
	const spread = (
		count: number,
		extra: Partial<FakeSubscriber> = {},
	): FakeSubscriber[] =>
		Array.from({ length: count }, (_, index) => ({
			id: index + 1,
			createdAt: daysBefore(index * 10, 5),
			addedAt: daysBefore(0, index + 1),
			...extra,
		}))
	const tagReads = (kit: ReturnType<typeof fakeKit>) =>
		kit.requests.filter((url) => url.pathname.startsWith('/v4/tags/'))
	const sequenceReads = (kit: ReturnType<typeof fakeKit>) =>
		kit.requests.filter((url) => url.pathname.startsWith('/v4/sequences/'))

	it('reads the tags in slices up to 7 creation-day slices, and whole at 8', async () => {
		expect(SKILLS_CONFIRMATION_TAG_SLICE_LIMIT).toBe(7)
		const seven = fakeKit(spread(7))
		const sliced = await run('daily', seven).receipt
		expect(sliced.tagRead).toBe('sliced')
		expect(tagReads(seven)).toHaveLength(2 * 7)
		expect(
			tagReads(seven).every((url) => url.searchParams.has('created_after')),
		).toBe(true)

		const eight = fakeKit(spread(8))
		const whole = await run('daily', eight).receipt
		expect(whole.tagRead).toBe('whole')
		expect(
			tagReads(eight)
				.map((url) => url.pathname)
				.sort(),
		).toEqual(['/v4/tags/19251081/subscribers', '/v4/tags/8244351/subscribers'])
		for (const url of tagReads(eight)) {
			expect(url.searchParams.has('created_after')).toBe(false)
			expect(url.searchParams.get('status')).toBe('all')
		}
		expect(sliced.counts.planned).toBe(7)
		expect(whole.counts.planned).toBe(8)
	})

	it('costs 100 opt-outs 10 days apart the tag lists and nothing more: no email 0 read, no check (Sonnet 2’s 405-call case)', async () => {
		const kit = fakeKit(spread(100, { tags: [8244351] }))
		const receipt = await run('daily', kit).receipt
		expect(receipt).toMatchObject({
			tagRead: 'whole',
			counts: { candidates: 0, excludedByTag: 100, tagChecked: 0 },
		})
		expect(sequenceReads(kit)).toEqual([])
		// 5 form reads and the two tag lists, one page each here.
		expect(receipt.kit.calls).toBe(7)
	})

	it('reads email 0 in at most 20 slices; candidates needing more wait a run, counted', async () => {
		expect(SKILLS_CONFIRMATION_EMAIL_ZERO_SLICE_LIMIT).toBe(20)
		const subscribers = spread(25)
		// A later candidate on a day already covered still fits.
		subscribers.push({
			id: 26,
			createdAt: subscribers[0]!.createdAt,
			addedAt: daysBefore(0, 30),
		})
		const kit = fakeKit(subscribers)
		const { receipt, sent } = run('daily', kit)
		expect((await receipt).counts).toMatchObject({
			deferredBySliceLimit: 5,
			candidates: 21,
			planned: 21,
			deferred: 5,
		})
		// Two sequences, 20 slices each.
		expect(sequenceReads(kit)).toHaveLength(2 * 20)
		expect(sentIds(sent)).not.toContain('21')
		expect(sentIds(sent)).toContain('26')
	})
})
