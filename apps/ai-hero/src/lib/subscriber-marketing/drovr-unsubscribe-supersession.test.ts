import { beforeEach, expect, it, vi } from 'vitest'
import {
	openStopBefore,
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
} from './drovr-outbox'
import {
	deliverDrovrShadowEvent,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import { deliverBatchOrThrow } from './drovr-shadow-delivery'
import {
	closeSupersededUnsubscribeRows,
	supersedingResubscribeAt,
} from './drovr-unsubscribe-supersession'
import { buildUnsubscribeSupersession } from './drovr-unsubscribe-supersession-proof'
const state = vi.hoisted(() => {
	const lifts = new Map<string, string>()
	const writes: Record<string, unknown>[] = []
	const retained: any[] = []
	const params = (value: any): unknown[] =>
		value?.queryChunks?.flatMap((part: any) =>
			part?.queryChunks
				? params(part)
				: part && 'value' in part
					? [part.value]
					: [],
		) ?? []
	let locked: any
	const select = vi.fn(() => {
		let keys: unknown[] = []
		let limit = Infinity
		const rows = () =>
			retained
				.filter((row) => !keys.length || keys.includes(row.dedupeKey))
				.slice(0, limit)
		const query: any = {
			from: () => query,
			where: (clause: unknown) => {
				keys = params(clause).filter(
					(value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
				)
				return query
			},
			limit: (count: number) => {
				limit = count
				return query
			},
			for: () => {
				locked = rows()[0]
				return query
			},
			then: (yes: any, no: any) => Promise.resolve(rows()).then(yes, no),
			groupBy: async () =>
				[...lifts].map(([contactId, at]) => ({ contactId, at })),
		}
		return query
	})
	const db: any = {
		select,
		transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(db)),
		update: () => ({
			set: (patch: Record<string, unknown>) => ({
				where: async () => {
					writes.push(patch)
					Object.assign(locked, patch)
					return [{ affectedRows: 1 }]
				},
			}),
		}),
	}
	return { lifts, writes, retained, db, capture: vi.fn() }
})
vi.mock('@/db', () => ({ db: state.db }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('./drovr-outbox-live', () => ({
	captureDrovrOutboxLive: state.capture,
	drovrOutboxTargetFromEnv: () => 'production',
}))
const config = {
	ingestUrl: 'https://drovr.example.test/events',
	apiKey: 'synthetic-fixture-key',
}
const unsubAt = '2032-01-01T10:00:00.000Z'
const liftAt = '2032-01-01T10:01:00.000Z'
const event = (
	type = 'contact.unsubscribed',
	occurredAt = unsubAt,
): DrovrShadowEvent =>
	({
		tenantId: 'org-aihero',
		contactId: 'synthetic-contact',
		journeyId: 'value-path-skills-course',
		type,
		occurredAt,
		idempotencyKey: `synthetic:${type}`,
	}) as DrovrShadowEvent
const fetcher = () =>
	vi.fn(async (_url: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body))
		return body.events
			? new Response(
					JSON.stringify({
						accepted: body.events.length,
						rejected: 0,
						failed: 0,
						results: body.events.map((_: unknown, index: number) => ({
							index,
							status: 'accepted',
						})),
					}),
					{ status: 200 },
				)
			: new Response(null, { status: 202 })
	})
const stored = (body: DrovrShadowEvent, id = 'synthetic-row') => ({
	...outboxEntryForEvent(body, 'live'),
	id,
	target: 'production',
	dedupeKey: drovrOutboxDedupeKey(
		'production',
		outboxEntryForEvent(body, 'live'),
	),
	status: 'pending',
	heldContinuation: null,
	firstFailedAt: body.occurredAt,
	lastAttemptAt: null,
	lastStatus: null,
	lastError: null,
})
beforeEach(() => {
	state.lifts.clear()
	state.writes.splice(0)
	state.retained.splice(0)
	vi.clearAllMocks()
	state.capture.mockImplementation(
		async (entries: ReturnType<typeof outboxEntryForEvent>[]) => {
			for (const entry of entries)
				if (
					!state.retained.some(
						(row) =>
							row.dedupeKey === drovrOutboxDedupeKey('production', entry),
					)
				)
					state.retained.push(stored(entry.body as DrovrShadowEvent))
			return { status: 'outboxed', count: entries.length }
		},
	)
})
it('closes a superseded historical unsubscribe at the actual single transport, with reason and no fetch', async () => {
	state.lifts.set('synthetic-contact', liftAt)
	const post = fetcher()
	const result = await deliverDrovrShadowEvent({
		event: event(),
		config,
		fetcher: post,
		clampAt: Date.parse(liftAt),
	})
	expect(result).toMatchObject({ status: 'superseded', supersededAt: liftAt })
	expect(post).not.toHaveBeenCalled()
	expect(state.capture).toHaveBeenCalledOnce()
	expect(state.writes).toHaveLength(1)
	expect(state.writes[0]).toMatchObject({
		status: 'superseded',
		lastError: expect.stringContaining('3mxwwjnmt7iq6'),
	})
})
it('never reopens a retained superseded row even if the original lift is no longer in source history', async () => {
	const stop = event()
	const row = stored(stop)
	state.retained.push({
		...row,
		status: 'superseded',
		heldContinuation: {
			v: 1,
			unsubscribeSupersession: buildUnsubscribeSupersession(
				row,
				liftAt,
				'2032-01-01T10:02:00.000Z',
			),
		},
	})
	const post = fetcher()
	expect(
		(
			await deliverDrovrShadowEvent({
				event: stop,
				config,
				fetcher: post,
				clampAt: Date.parse(liftAt),
			})
		).status,
	).toBe('superseded')
	expect(post).not.toHaveBeenCalled()
	expect(state.capture).not.toHaveBeenCalled()
})
it('an optional outbox table not yet installed does not block an active unsubscribe', async () => {
	state.db.select.mockImplementationOnce(() => {
		throw Object.assign(new Error('missing optional table'), { errno: 1146 })
	})
	const post = fetcher()
	expect(
		(
			await deliverDrovrShadowEvent({
				event: event(),
				config,
				fetcher: post,
				clampAt: Date.parse(liftAt),
			})
		).status,
	).toBe('accepted')
	expect(post).toHaveBeenCalledOnce()
})
it('a known superseded unsubscribe cannot post when its required audit closure cannot persist', async () => {
	state.lifts.set('synthetic-contact', liftAt)
	state.capture.mockResolvedValueOnce({ status: 'unavailable' })
	const post = fetcher()
	expect(
		await deliverDrovrShadowEvent({
			event: event(),
			config,
			fetcher: post,
			clampAt: Date.parse(liftAt),
		}),
	).toMatchObject({
		status: 'failed',
		reason: expect.stringContaining('UnsubscribeClosure:'),
	})
	expect(post).not.toHaveBeenCalled()
})
it('filters a superseded batch item without faking acceptance or shifting remaining result indexes', async () => {
	state.lifts.set('synthetic-contact', liftAt)
	const post = fetcher()
	const result = await deliverBatchOrThrow({
		events: [event(), event('contact.bounced'), event('contact.complained')],
		config,
		fetcher: post,
		clampAt: Date.parse(liftAt),
	})
	expect(result).toEqual({
		accepted: 2,
		rejected: 0,
		supersededUnsubscribes: 1,
	})
	expect(post).toHaveBeenCalledOnce()
	expect(
		JSON.parse(String(post.mock.calls[0]![1]!.body)).events.map(
			(e: DrovrShadowEvent) => e.type,
		),
	).toEqual(['contact.bounced', 'contact.complained'])
})
it('a whole-second timestamp tie keeps the unsubscribe and posts it unchanged', async () => {
	state.lifts.set('synthetic-contact', unsubAt)
	const stop = event('contact.unsubscribed', '2032-01-01T10:00:00.999Z')
	const post = fetcher()
	expect(
		await deliverDrovrShadowEvent({
			event: stop,
			config,
			fetcher: post,
			clampAt: Date.parse(liftAt),
		}),
	).toEqual({ status: 'accepted' })
	expect(JSON.parse(String(post.mock.calls[0]![1]!.body))).toEqual(stop)
	expect(state.capture).not.toHaveBeenCalled()
	expect(state.writes).toHaveLength(0)
})
it('bounces and complaints pass through despite any newer resubscribe, without even reading lift evidence', async () => {
	state.lifts.set('synthetic-contact', liftAt)
	const post = fetcher()
	for (const type of ['contact.bounced', 'contact.complained'])
		expect(
			await deliverDrovrShadowEvent({
				event: event(type),
				config,
				fetcher: post,
				clampAt: Date.parse(liftAt),
			}),
		).toEqual({ status: 'accepted' })
	expect(post).toHaveBeenCalledTimes(2)
	expect(state.db.select).not.toHaveBeenCalled()
	expect(state.capture).not.toHaveBeenCalled()
	expect(state.writes).toHaveLength(0)
})
it('gate hydration closes only an old unsubscribe, preserving ties and permanent stops', async () => {
	state.lifts.set('synthetic-contact', liftAt)
	const rows = [
		event(),
		event('contact.unsubscribed', liftAt),
		event('contact.bounced'),
		event('contact.complained'),
	].map((e, index) =>
		stored(
			{ ...e, idempotencyKey: `${e.idempotencyKey}:${index}` },
			String(index),
		),
	)
	state.retained.push(...rows)
	const closed = await closeSupersededUnsubscribeRows(
		state.db,
		'production',
		rows,
	)
	expect(closed.map((row) => row.status)).toEqual([
		'superseded',
		'pending',
		'pending',
		'pending',
	])
	expect(closed[0]!.supersededAt).toBe(liftAt)
	expect(state.writes).toHaveLength(1)
})
it('the lift permits newly planned work, never revives old work, and never lifts a bounce/complaint gate', () => {
	const stop = {
		eventType: 'contact.unsubscribed',
		occurredAt: unsubAt,
		supersededAt: liftAt,
	}
	expect(
		openStopBefore(
			{ eventType: 'contact.profile.updated', occurredAt: liftAt },
			[stop],
		),
	).toBeUndefined()
	expect(
		openStopBefore(
			{
				eventType: 'contact.profile.updated',
				occurredAt: '2032-01-01T10:00:30.000Z',
			},
			[stop],
		),
	).toBe(stop)
	for (const eventType of ['contact.bounced', 'contact.complained']) {
		const permanent = { ...stop, eventType }
		expect(
			openStopBefore(
				{ eventType: 'contact.profile.updated', occurredAt: liftAt },
				[permanent],
			),
		).toBe(permanent)
	}
	expect(
		supersedingResubscribeAt(
			{ eventType: 'contact.unsubscribed', occurredAt: 'unreadable' },
			liftAt,
		),
	).toBeUndefined()
})
it('never trusts a retained prose-only closed status after source history is gone', async () => {
	state.retained.push({
		...stored(event()),
		status: 'superseded',
		lastError: `superseded-unsubscribe:${liftAt}; synthetic lookalike`,
	})
	const post = fetcher()
	expect(
		await deliverDrovrShadowEvent({
			event: event(),
			config,
			fetcher: post,
			clampAt: Date.parse(liftAt),
		}),
	).toMatchObject({
		status: 'failed',
		reason: expect.stringContaining('UnsubscribeClosure:'),
	})
	expect(post).not.toHaveBeenCalled()
	expect(state.capture).not.toHaveBeenCalled()
})
it('a missing-column gate reader neither licenses closure nor writes a replacement diagnostic protocol', async () => {
	const row = {
		...stored(event()),
		status: 'superseded',
		heldContinuationAvailable: false,
	}
	state.lifts.set(row.contactId, liftAt)
	const [gate] = await closeSupersededUnsubscribeRows(state.db, 'production', [
		row,
	])
	expect(gate).toMatchObject({
		status: 'superseded',
		unsubscribeSupersessionError: expect.stringContaining('missing-proof'),
	})
	expect(gate?.supersededAt).toBeUndefined()
	expect(state.db.select).not.toHaveBeenCalled()
	expect(state.writes).toHaveLength(0)
})
it('a delivered carrier retains actual status/body/clocks/HTTP history while adding only closure metadata', async () => {
	const row = {
		...stored(event()),
		status: 'delivered',
		lastStatus: 202,
		lastAttemptAt: unsubAt,
		deliveredAt: unsubAt,
		lastError: 'synthetic prior HTTP diagnostic',
	}
	const before = structuredClone(row)
	state.retained.push(row)
	state.lifts.set(row.contactId, liftAt)
	const post = fetcher()
	expect(
		await deliverDrovrShadowEvent({
			event: event(),
			config,
			fetcher: post,
			clampAt: Date.parse(liftAt),
		}),
	).toMatchObject({ status: 'superseded', supersededAt: liftAt })
	expect(post).not.toHaveBeenCalled()
	const { heldContinuation: _previousMetadata, ...history } = before
	expect(row).toMatchObject(history)
	expect(Object.keys(state.writes[0]!)).toEqual(['heldContinuation'])
})
it('a stale source scan cannot regress the retained typed boundary or its decision time', async () => {
	const { persistUnsubscribeSupersession } =
		await import('./drovr-unsubscribe-supersession-persistence')
	const row = stored(event())
	const newer = '2032-01-01T10:02:00.000Z'
	const proof = buildUnsubscribeSupersession(
		row,
		newer,
		'2032-01-01T10:03:00.000Z',
	)
	state.retained.push({
		...row,
		status: 'superseded',
		heldContinuation: {
			v: 1,
			unsubscribeSupersession: proof,
			replayProof: { v: 1, handoffs: 3 },
		},
	})
	const result = await persistUnsubscribeSupersession(state.db, {
		target: row.target,
		key: row.dedupeKey,
		contactId: row.contactId,
		resubscribedAt: liftAt,
	})
	expect(result.heldContinuation).toMatchObject({
		unsubscribeSupersession: proof,
		replayProof: { v: 1, handoffs: 3 },
	})
	expect(result.body).toEqual(row.body)
	expect(result.firstFailedAt).toBe(row.firstFailedAt)
})
