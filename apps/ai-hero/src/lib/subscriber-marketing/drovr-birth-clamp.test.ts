import { describe, expect, it, vi } from 'vitest'

import {
	clampBirths,
	DROVR_BIRTH_CLAMP_SKEW_MS,
	isSendingJourneyBirth,
} from './drovr-birth-clamp'
import { deliverBatchOrThrow } from './drovr-shadow-delivery'
import {
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

describe('row 201g: a sending-journey birth is never older than 5 minutes when it reaches drovr', () => {
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
		const { events, lagSeconds } = clampBirths(
			[valuePathBirth, newsletterBirth, evergreenBirth],
			NOW,
		)
		const floor = new Date(NOW - DROVR_BIRTH_CLAMP_SKEW_MS).toISOString()
		expect(events.map((e) => e.occurredAt)).toEqual([floor, floor, floor])
		expect(lagSeconds).toEqual([3600, 3600, 3600])
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
			now: () => NOW,
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
			lagSeconds: [3600],
		})
	})

	it('posts a directory birth as it is, and logs nothing', async () => {
		const fetcher = vi.fn(async () => new Response('{}', { status: 202 }))
		const info = vi.fn()
		await deliverDrovrShadowEvent({
			event: directoryBirth,
			config,
			fetcher,
			now: () => NOW,
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
			now: () => NOW,
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
			lagSeconds: [3600],
		})
	})

	it('relies on drovr being first-write-wins by key: a retry posts a later instant under the same key', async () => {
		// drovr adapter-d1 event-log.ts EventLog.append: a duplicate key
		// returns the stored event ({ appended: false, event: existing }), with
		// no body compare. So the retry below dedupes against the first post
		// instead of conflicting with it. If drovr ever compares bodies, this
		// clamp must move to capture time.
		const fetcher = vi.fn(async () => new Response('{}', { status: 202 }))
		for (const at of [NOW, NOW + 10 * 60_000])
			await deliverDrovrShadowEvent({
				event: valuePathBirth,
				config,
				fetcher,
				now: () => at,
				info: vi.fn(),
			})
		const [first, retry] = fetcher.mock.calls.map(
			(call) =>
				JSON.parse(
					(call as unknown as [string, { body: string }])[1].body,
				) as DrovrShadowEvent,
		)
		expect(first!.occurredAt).not.toBe(retry!.occurredAt)
		expect({ ...retry, occurredAt: first!.occurredAt }).toEqual(first)
	})
})
