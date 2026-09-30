import { describe, expect, it, vi } from 'vitest'

import {
	clampBirths,
	DROVR_BIRTH_CLAMP_SKEW_MS,
	DROVR_CLAMP_LOG_SAMPLE,
	isSendingJourneyBirth,
	logClampedBirths,
} from './drovr-birth-clamp'
import {
	captureDrovrOutbox,
	outboxEntryForEvent,
	type DrovrOutboxRow,
	type DrovrOutboxStore,
} from './drovr-outbox'
import { postDrovrOutboxRow } from './drovr-outbox-replay-post'
import { deliverBatchOrThrow } from './drovr-shadow-delivery'
import {
	deliverDrovrShadowEventsDirect,
	emitDrovrShadowEvents,
	DROVR_CONTACT_DIRECTORY_JOURNEY_ID,
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
	deliverDrovrShadowEvent,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'

const NOW = Date.parse('2026-09-30T06:00:00.000Z')
const config = { ingestUrl: 'https://drovr.test/events', apiKey: 'k' }

const event = (
	overrides: Partial<DrovrShadowEvent> = {},
): DrovrShadowEvent => ({
	tenantId: 'org-aihero',
	contactId: 'contact-1',
	journeyId: DROVR_SKILLS_COURSE_JOURNEY_ID,
	type: 'contact.created',
	occurredAt: '2026-09-30T05:00:00.000Z',
	idempotencyKey: 'aihero:birth:1',
	...overrides,
})

const valuePathBirth = event()
const newsletterBirth = event({
	journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	idempotencyKey: 'owner:aihero:newsletter:1',
})
const evergreenBirth = event({
	journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	type: 'course.sequence-exhausted',
	idempotencyKey: 'aihero:backfill:contact-1:x:2026-09-30',
	payload: { valuePathSlug: 'x', completedAt: '2026-09-17T12:00:00.000Z' },
} as Partial<DrovrShadowEvent>)
const directoryBirth = event({
	journeyId: DROVR_CONTACT_DIRECTORY_JOURNEY_ID,
	occurredAt: '2023-01-01T00:00:00.000Z',
	idempotencyKey: 'directory:seed:contact-1',
})

describe('row 201g: a sending-journey birth is never older than 5 minutes at its first send', () => {
	it('names the births it clamps: contact.created off the directory, and the evergreen offer start', () => {
		expect(isSendingJourneyBirth(valuePathBirth)).toBe(true)
		expect(isSendingJourneyBirth(newsletterBirth)).toBe(true)
		expect(isSendingJourneyBirth(evergreenBirth)).toBe(true)
		expect(isSendingJourneyBirth(directoryBirth)).toBe(false)
		// The skills course's exhaustion is a fact there, not a birth.
		expect(
			isSendingJourneyBirth(event({ type: 'course.sequence-exhausted' })),
		).toBe(false)
		for (const type of [
			'contact.unsubscribed',
			'purchase.recorded',
			'value-path.answer-selected',
			'email.completed',
		] as const)
			expect(isSendingJourneyBirth(event({ type }))).toBe(false)
	})

	it('moves an old birth up to now minus 5 minutes, and reports its lag in whole seconds', () => {
		const { events, lagSeconds, journeyIds } = clampBirths(
			[valuePathBirth, newsletterBirth, evergreenBirth],
			NOW,
		)
		const floor = new Date(NOW - DROVR_BIRTH_CLAMP_SKEW_MS).toISOString()
		expect(events.map((e) => e.occurredAt)).toEqual([floor, floor, floor])
		expect(lagSeconds).toEqual([3600, 3600, 3600])
		expect(journeyIds).toEqual([
			DROVR_SKILLS_COURSE_JOURNEY_ID,
			DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
			DROVR_EVERGREEN_OFFER_JOURNEY_ID,
		])
		expect(DROVR_BIRTH_CLAMP_SKEW_MS).toBe(5 * 60_000)
	})

	it('changes nothing but occurredAt: same key, same payload (drovr dedupes by key)', () => {
		const [clamped] = clampBirths([evergreenBirth], NOW).events
		expect({ ...clamped, occurredAt: evergreenBirth.occurredAt }).toEqual(
			evergreenBirth,
		)
	})

	it('leaves a birth inside the skew, at the floor, in the future, or unparsable', () => {
		const inside = event({
			occurredAt: new Date(
				NOW - DROVR_BIRTH_CLAMP_SKEW_MS + 1000,
			).toISOString(),
		})
		const atFloor = event({
			occurredAt: new Date(NOW - DROVR_BIRTH_CLAMP_SKEW_MS).toISOString(),
		})
		const future = event({ occurredAt: '2026-09-30T07:00:00.000Z' })
		const garbage = event({ occurredAt: 'not a time' })
		const clamped = clampBirths([inside, atFloor, future, garbage], NOW)
		expect(clamped.events).toEqual([inside, atFloor, future, garbage])
		expect(clamped.lagSeconds).toEqual([])
	})

	it('never touches a directory birth, a stop or a fact, however old', () => {
		const stop = event({
			type: 'contact.unsubscribed',
			occurredAt: '2025-01-01T00:00:00.000Z',
		})
		const fact = event({
			type: 'value-path.answer-selected',
			occurredAt: '2025-01-01T00:00:00.000Z',
		})
		const clamped = clampBirths([directoryBirth, stop, fact], NOW)
		expect(clamped.events).toEqual([directoryBirth, stop, fact])
		expect(clamped.lagSeconds).toEqual([])
	})

	it('clamps a single post and logs the clamp with its lag', async () => {
		const fetcher = vi.fn(async () => new Response('{}', { status: 202 }))
		const info = vi.fn()
		await deliverDrovrShadowEvent({
			event: valuePathBirth,
			config,
			fetcher,
			clampAt: NOW,
			info,
		})
		const posted = JSON.parse(
			(fetcher.mock.calls[0] as unknown as [string, { body: string }])[1].body,
		)
		expect(posted.occurredAt).toBe('2026-09-30T05:55:00.000Z')
		expect(info).toHaveBeenCalledWith('drovr.birth.clamped', {
			path: 'single',
			count: 1,
			maxLagSeconds: 3600,
			journeyCounts: { [DROVR_SKILLS_COURSE_JOURNEY_ID]: 1 },
			lagSeconds: [3600],
			journeyIds: [DROVR_SKILLS_COURSE_JOURNEY_ID],
		})
	})

	it('posts a directory birth as it is, and logs nothing', async () => {
		const fetcher = vi.fn(async () => new Response('{}', { status: 202 }))
		const info = vi.fn()
		await deliverDrovrShadowEvent({
			event: directoryBirth,
			config,
			fetcher,
			clampAt: NOW,
			info,
		})
		const posted = JSON.parse(
			(fetcher.mock.calls[0] as unknown as [string, { body: string }])[1].body,
		)
		expect(posted).toEqual(directoryBirth)
		expect(info).not.toHaveBeenCalled()
	})

	it('clamps the births in a batch, leaves the rest, and logs one line per batch', async () => {
		const stop = event({
			type: 'contact.unsubscribed',
			idempotencyKey: 'aihero:stop:1',
		})
		const fetcher = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						accepted: 3,
						rejected: 0,
						failed: 0,
						results: [0, 1, 2].map((index) => ({
							index,
							status: 'accepted',
						})),
					}),
					{ status: 200 },
				),
		)
		const info = vi.fn()
		const answer = await deliverBatchOrThrow({
			events: [evergreenBirth, stop, directoryBirth],
			config,
			fetcher,
			warn: vi.fn(),
			clampAt: NOW,
			info,
		})
		expect(answer).toMatchObject({ accepted: 3, rejected: 0 })
		const posted = JSON.parse(
			(fetcher.mock.calls[0] as unknown as [string, { body: string }])[1].body,
		).events as DrovrShadowEvent[]
		expect(posted.map((e) => e.occurredAt)).toEqual([
			'2026-09-30T05:55:00.000Z',
			stop.occurredAt,
			directoryBirth.occurredAt,
		])
		expect(info).toHaveBeenCalledOnce()
		expect(info).toHaveBeenCalledWith('drovr.birth.clamped', {
			path: 'batch',
			count: 1,
			maxLagSeconds: 3600,
			journeyCounts: { [DROVR_EVERGREEN_OFFER_JOURNEY_ID]: 1 },
			lagSeconds: [3600],
			journeyIds: [DROVR_EVERGREEN_OFFER_JOURNEY_ID],
		})
	})
})

const bodyOf = (call: unknown) => (call as [string, { body: string }])[1].body

const batchAnswer = (statuses: string[]) =>
	new Response(
		JSON.stringify({
			accepted: statuses.filter((status) => status === 'accepted').length,
			rejected: statuses.filter((status) => status === 'rejected').length,
			failed: statuses.filter((status) => status === 'failed').length,
			results: statuses.map((status, index) =>
				status === 'rejected'
					? { index, status, detail: { title: 'bad' } }
					: { index, status },
			),
		}),
		{ status: 200 },
	)

describe("row 201g (#345 S1): every retry and replay posts the first send's bytes", () => {
	// drovr's log keeps the first write of a key, but deliverEvent forwards
	// the REQUEST's event to the actor even on a duplicate append (apps/api
	// events.ts). So after an ambiguous first post (the append landed, the
	// answer did not), a retry must post byte-identical, or the actor folds
	// an occurredAt the log does not hold.
	const TEN_MINUTES = 10 * 60_000

	it('the single path: an ambiguous first post, then a retry 10 minutes later, posts identical bytes', async () => {
		let calls = 0
		const fetcher = vi.fn(async () => {
			calls += 1
			if (calls === 1) throw new Error('timeout')
			return new Response('{}', { status: 202 })
		})
		vi.useFakeTimers({ toFake: ['Date'] })
		try {
			vi.setSystemTime(NOW)
			const first = await deliverDrovrShadowEvent({
				event: valuePathBirth,
				config,
				fetcher,
				clampAt: NOW,
				info: vi.fn(),
			})
			vi.setSystemTime(NOW + TEN_MINUTES)
			const retry = await deliverDrovrShadowEvent({
				event: valuePathBirth,
				config,
				fetcher,
				clampAt: NOW,
				info: vi.fn(),
			})
			expect(first.status).toBe('failed')
			expect(retry.status).toBe('accepted')
		} finally {
			vi.useRealTimers()
		}
		const [firstBody, retryBody] = fetcher.mock.calls.map(bodyOf)
		expect(retryBody).toBe(firstBody)
		expect(JSON.parse(firstBody!).occurredAt).toBe('2026-09-30T05:55:00.000Z')
	})

	it('the batch path: a failed chunk, then its retry 10 minutes later, posts identical bytes', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(new Response('{}', { status: 503 }))
			.mockResolvedValueOnce(batchAnswer(['accepted', 'accepted']))
		vi.useFakeTimers({ toFake: ['Date'] })
		try {
			vi.setSystemTime(NOW)
			await expect(
				deliverBatchOrThrow({
					events: [evergreenBirth, directoryBirth],
					config,
					fetcher,
					warn: vi.fn(),
					clampAt: NOW,
					info: vi.fn(),
				}),
			).rejects.toThrow()
			vi.setSystemTime(NOW + TEN_MINUTES)
			await deliverBatchOrThrow({
				events: [evergreenBirth, directoryBirth],
				config,
				fetcher,
				warn: vi.fn(),
				clampAt: NOW,
				info: vi.fn(),
			})
		} finally {
			vi.useRealTimers()
		}
		const [firstBody, retryBody] = fetcher.mock.calls.map(bodyOf)
		expect(retryBody).toBe(firstBody)
	})

	it("the replay: a row captured after a failed send posts that send's bytes, on every replay", async () => {
		// The live send at NOW fails; the last attempt captures the event with
		// the send's instant, which becomes the row's firstFailedAt.
		const firstSend = vi.fn(async () => new Response('{}', { status: 503 }))
		await deliverDrovrShadowEvent({
			event: valuePathBirth,
			config,
			fetcher: firstSend,
			clampAt: NOW,
			info: vi.fn(),
		})
		const rows: DrovrOutboxRow[] = []
		await captureDrovrOutbox({
			store: {
				insertIgnore: async (inserted: DrovrOutboxRow[]) => {
					rows.push(...inserted)
				},
			} as unknown as DrovrOutboxStore,
			target: 'production',
			entries: [outboxEntryForEvent(valuePathBirth, 'live', { sentAt: NOW })],
			reason: new Error('drovr answered 503'),
			httpStatus: 503,
			// Captured on the last attempt, well after the first send.
			now: new Date(NOW + 2 * 60 * 60_000),
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		})
		const [row] = rows
		expect(row!.firstFailedAt).toBe(new Date(NOW).toISOString())
		expect(row).not.toHaveProperty('firstSentAt')
		// The row keeps the event as built; the clamp is the replay's.
		expect(row!.body).toEqual(valuePathBirth)
		expect(row!.occurredAt).toBe(valuePathBirth.occurredAt)

		const replayed = vi.fn(async () => new Response('{}', { status: 202 }))
		vi.useFakeTimers({ toFake: ['Date'] })
		try {
			for (const minutes of [79, 240]) {
				vi.setSystemTime(NOW + minutes * 60_000)
				await postDrovrOutboxRow(row!, {
					ingestUrl: config.ingestUrl,
					apiKeyFor: () => config.apiKey,
					deliver: (args) =>
						deliverDrovrShadowEvent({ ...args, fetcher: replayed }),
					fanOut: async (events) => [...events],
					isNeverBornOwnerStop: () => false,
				})
			}
		} finally {
			vi.useRealTimers()
		}
		const first = bodyOf(firstSend.mock.calls[0])
		expect(replayed.mock.calls.map(bodyOf)).toEqual([first, first])
	})

	it('a row never sent is clamped at its capture, the same on every replay', async () => {
		const rows: DrovrOutboxRow[] = []
		const capturedAt = NOW + 30 * 60_000
		await captureDrovrOutbox({
			store: {
				insertIgnore: async (inserted: DrovrOutboxRow[]) => {
					rows.push(...inserted)
				},
			} as unknown as DrovrOutboxStore,
			target: 'production',
			entries: [outboxEntryForEvent(valuePathBirth, 'live')],
			reason: new Error('held behind an owed stop'),
			now: new Date(capturedAt),
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		})
		expect(rows[0]!.firstFailedAt).toBe(new Date(capturedAt).toISOString())
		const replayed = vi.fn(async () => new Response('{}', { status: 202 }))
		for (let replay = 0; replay < 2; replay += 1)
			await postDrovrOutboxRow(rows[0]!, {
				ingestUrl: config.ingestUrl,
				apiKeyFor: () => config.apiKey,
				deliver: (args) =>
					deliverDrovrShadowEvent({ ...args, fetcher: replayed }),
				fanOut: async (events) => [...events],
				isNeverBornOwnerStop: () => false,
			})
		const bodies = replayed.mock.calls.map(bodyOf)
		expect(bodies[1]).toBe(bodies[0])
		expect(JSON.parse(bodies[0]!).occurredAt).toBe(
			new Date(capturedAt - DROVR_BIRTH_CLAMP_SKEW_MS).toISOString(),
		)
	})
})

describe("row 201g: the clamp's edges (Sonnet 2 X1 to X3)", () => {
	const birth = (n: number, at: string) =>
		event({ contactId: `c-${n}`, occurredAt: at, idempotencyKey: `k:${n}` })

	it('reports each lag floored to whole seconds, and the largest as maxLagSeconds', async () => {
		const births = [
			birth(1, '2026-09-30T05:30:00.000Z'),
			birth(2, '2026-09-30T05:00:00.000Z'),
			birth(3, new Date(NOW - 400_999).toISOString()),
		]
		expect(clampBirths(births, NOW).lagSeconds).toEqual([1800, 3600, 400])
		const info = vi.fn()
		await logClampedBirths(clampBirths(births, NOW), 'batch', info)
		expect(info).toHaveBeenCalledWith('drovr.birth.clamped', {
			path: 'batch',
			count: 3,
			maxLagSeconds: 3600,
			journeyCounts: { [DROVR_SKILLS_COURSE_JOURNEY_ID]: 3 },
			lagSeconds: [1800, 3600, 400],
			journeyIds: [
				DROVR_SKILLS_COURSE_JOURNEY_ID,
				DROVR_SKILLS_COURSE_JOURNEY_ID,
				DROVR_SKILLS_COURSE_JOURNEY_ID,
			],
		})
	})

	it('lists only the first 10 lags and journeys, and counts and maxes them all', async () => {
		const births = Array.from({ length: 25 }, (_, n) =>
			birth(n, new Date(NOW - (n + 1) * 600_000).toISOString()),
		)
		const info = vi.fn()
		await logClampedBirths(clampBirths(births, NOW), 'batch', info)
		expect(info).toHaveBeenCalledWith('drovr.birth.clamped', {
			path: 'batch',
			count: 25,
			maxLagSeconds: 25 * 600,
			journeyCounts: { [DROVR_SKILLS_COURSE_JOURNEY_ID]: 25 },
			lagSeconds: Array.from(
				{ length: DROVR_CLAMP_LOG_SAMPLE },
				(_, n) => (n + 1) * 600,
			),
			journeyIds: Array.from(
				{ length: DROVR_CLAMP_LOG_SAMPLE },
				() => DROVR_SKILLS_COURSE_JOURNEY_ID,
			),
		})
	})

	it('hands a refused birth back with its own occurredAt, never the clamped one', async () => {
		const fetcher = vi.fn(async () => batchAnswer(['rejected']))
		const answer = await deliverBatchOrThrow({
			events: [valuePathBirth],
			config,
			fetcher,
			warn: vi.fn(),
			clampAt: NOW,
			info: vi.fn(),
		})
		expect(JSON.stringify(answer)).toContain(valuePathBirth.occurredAt)
		expect(JSON.stringify(answer)).not.toContain('05:55:00')
	})

	it('never lets a throwing logger stop a clamped send, single or batch', async () => {
		const info = vi.fn(async () => {
			throw new Error('axiom down')
		})
		const single = vi.fn(async () => new Response('{}', { status: 202 }))
		await expect(
			deliverDrovrShadowEvent({
				event: valuePathBirth,
				config,
				fetcher: single,
				clampAt: NOW,
				info,
			}),
		).resolves.toMatchObject({ status: 'accepted' })
		expect(single).toHaveBeenCalledOnce()
		const batch = vi.fn(async () => batchAnswer(['accepted']))
		await expect(
			deliverBatchOrThrow({
				events: [valuePathBirth],
				config,
				fetcher: batch,
				warn: vi.fn(),
				clampAt: NOW,
				info,
			}),
		).resolves.toMatchObject({ accepted: 1 })
		expect(batch).toHaveBeenCalledOnce()
	})

	it("clamps the dispatch fallback's direct post at the instant it is given", async () => {
		const fetcher = vi.fn(async () => new Response('{}', { status: 503 }))
		const unsent = await deliverDrovrShadowEventsDirect([valuePathBirth], {
			config: { ingestUrl: config.ingestUrl, authorityApiKey: config.apiKey },
			fetch: fetcher,
			info: vi.fn(),
			warn: vi.fn(),
			clampAt: NOW,
		})
		expect(JSON.parse(bodyOf(fetcher.mock.calls[0])).occurredAt).toBe(
			'2026-09-30T05:55:00.000Z',
		)
		// Handed back as built: the outbox entry carries the instant instead.
		expect(unsent).toEqual([valuePathBirth])
	})

	it('clamps the legacy emit road too (emitDrovrShadowEvents), so no post skips it', async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(JSON.stringify({ appended: true }), { status: 202 }),
		)
		await emitDrovrShadowEvents([valuePathBirth], {
			config: { ingestUrl: config.ingestUrl, authorityApiKey: config.apiKey },
			fetch: fetcher,
			info: vi.fn(),
			warn: vi.fn(),
			clampAt: NOW,
		})
		expect(JSON.parse(bodyOf(fetcher.mock.calls[0])).occurredAt).toBe(
			'2026-09-30T05:55:00.000Z',
		)
	})
})
