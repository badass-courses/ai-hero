import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	reconcileSkillsConfirmations,
	ReconcilerEvidenceUnavailableError,
	SKILLS_CONFIRMATION_RECENT_TIER_DAYS,
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
 * Kit's form, sequence and subscriber-tags reads, with the edges measured
 * on 2026-09-30: `created_after` inclusive, `created_before` exclusive.
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
		if (sequence) {
			const after = Date.parse(url.searchParams.get('created_after')!)
			const before = Date.parse(url.searchParams.get('created_before')!)
			return Response.json({
				subscribers: subscribers
					.filter(
						(subscriber) =>
							subscriber.sequences?.includes(sequence) &&
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
	options: { limit?: number; sleeps?: number[] } = {},
) {
	const stepIds: string[] = []
	const sent: Array<{ id: string; event: SkillsConfirmationEvent }> = []
	const receipt = reconcileSkillsConfirmations({
		tier,
		to: TO,
		limit: options.limit ?? 50,
		database: emptyDatabase(),
		kit: {
			fetch: kit.fetcher,
			sleep: async (milliseconds) => {
				options.sleeps?.push(milliseconds)
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

	it('checks the opt-out tags per candidate, never by listing a tag', async () => {
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
			counts: { tagChecked: 3, excludedByTag: 2, excludedOptedOut: 2 },
		})
		expect(sentIds(sent)).toEqual(['1'])
		const paths = kitPaths(kit)
		expect(paths.filter((path) => path.startsWith('tags/'))).toEqual([])
		expect(paths.filter((path) => path.endsWith('/tags'))).toEqual([
			'subscribers/1/tags',
			'subscribers/2/tags',
			'subscribers/3/tags',
		])
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
		['429 after the backoff', () => new Response('', { status: 429 })],
	])(
		'fails a tag check closed on %s: that subscriber is not sent, nor any after (the owner’s test c)',
		async (_, answer) => {
			const kit = two((url) =>
				url.pathname === '/v4/subscribers/2/tags' ? answer() : undefined,
			)
			const { receipt, sent } = run('recent', kit)
			await expect(receipt).rejects.toBeInstanceOf(
				ReconcilerEvidenceUnavailableError,
			)
			// Subscriber 1 cleared first and was sent; 2 never is.
			expect(sentIds(sent)).toEqual(['1'])
		},
	)

	it('sends nobody when the first tag check fails', async () => {
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
	})

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
