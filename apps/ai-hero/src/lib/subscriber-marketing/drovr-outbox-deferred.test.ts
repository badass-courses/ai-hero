import { expect, it, vi } from 'vitest'
import {
	drovrOutboxDedupeKey,
	isEventNotLiveDeferred,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from './drovr-outbox'
import { queueCappedReplay } from './contact-sync-replay-queue'
import { readOutboxQueueState } from './drovr-outbox-queue-state'
import { deliverDrovrShadowEvent } from './drovr-shadow-emitter'
import { deliverOrThrow } from './drovr-shadow-delivery'

const at = '2026-10-16T12:00:00.000Z'
function row(): DrovrOutboxRow {
	const event = {
		tenantId: 'org-aihero',
		contactId: 'synthetic-contact',
		journeyId: 'value-path-skills-course',
		type: 'contact.unsubscribed',
		idempotencyKey: 'synthetic:unsubscribe',
		occurredAt: at,
	} as const
	const entry = outboxEntryForEvent(event, 'bulkIngest')
	return {
		...entry,
		id: 'synthetic-row',
		target: 'synthetic-target',
		dedupeKey: drovrOutboxDedupeKey('synthetic-target', entry),
		status: 'pending',
		attempts: 0,
		queueHandoffs: 8,
		lastStatus: 409,
		lastError: 'event-not-live: synthetic prose',
		firstFailedAt: at,
		nextAttemptAt: at,
		lastAttemptAt: null,
		deliveredAt: null,
		releasedAt: null,
		createdAt: at,
	}
}
it('a pending lookalike error cannot bypass the actual eighth-handoff guard', async () => {
	const send = vi.fn()
	const lease = vi.fn(async () => true)
	expect(
		await queueCappedReplay(row(), send, Date.parse(at), lease, vi.fn()),
	).toMatchObject({ kind: 'held' })
	expect(send).not.toHaveBeenCalled()
	expect(lease).not.toHaveBeenCalled()
})
it('only explicit deferred status exempts a handoff and preserves original bytes/clocks', async () => {
	const retained = {
		...row(),
		status: 'deferred' as const,
		lastError: 'unrelated operator note',
		lastStatus: 500,
	}
	const before = structuredClone(retained)
	const send = vi.fn()
	const lease = vi.fn(async () => true)
	expect(
		await queueCappedReplay(retained, send, Date.parse(at), lease, vi.fn()),
	).toMatchObject({ kind: 'queued', phase: 'published' })
	expect(send).toHaveBeenCalledOnce()
	expect(send.mock.calls[0]![0]).toMatchObject({
		data: { events: [before.body], firstFailedAt: before.firstFailedAt },
	})
	expect(retained).toEqual(before)
})
it('property: lastError and lastStatus never choose deferred status (250 seeded cases)', () => {
	let seed = 0x8031
	const statuses = [
		'pending',
		'deferred',
		'delivered',
		'rejected',
		'held',
		'superseded',
	] as const
	for (let trial = 0; trial < 250; trial++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
		const retained = {
			...row(),
			status: statuses[trial % statuses.length]!,
			lastStatus: trial % 3 ? 409 : 503,
			lastError: [
				`event-not-live: ${seed}`,
				JSON.stringify({ status: 'deferred' }),
				'EventNotLive: synthetic note',
				null,
			][trial % 4]!,
		}
		expect(isEventNotLiveDeferred(retained)).toBe(
			retained.status === 'deferred',
		)
	}
})
it('never reads error prose, including a throwing getter at the real queue boundary', async () => {
	const retained = row()
	Object.defineProperty(retained, 'lastError', {
		get: () => {
			throw new Error('prose became a deferred protocol')
		},
	})
	expect(isEventNotLiveDeferred(retained)).toBe(false)
	expect(
		await queueCappedReplay(
			retained,
			vi.fn(),
			Date.parse(at),
			vi.fn(),
			vi.fn(),
		),
	).toMatchObject({ kind: 'held' })
})
it('stop-wait control comes only from typed replayProof, not the diagnostic sentinel', () => {
	const diagnostic = 'waiting behind an earlier stop'
	expect(
		readOutboxQueueState(undefined, diagnostic).waitingForStop,
	).toBeUndefined()
	expect(
		readOutboxQueueState(
			{ v: 1, replayProof: { v: 1, handoffs: 0, waitingForStop: true } },
			'unrelated note',
		).waitingForStop,
	).toBe(true)
	expect(
		readOutboxQueueState(
			{ v: 1, replayProof: { v: 1, handoffs: 0, waitingForStop: 'true' } },
			diagnostic,
		).invalid,
	).toBe(true)
})
it('actual coded 409 is an explicit healthy outcome, not a throw, acceptance or prose protocol', async () => {
	const event = {
		tenantId: 'org-aihero',
		contactId: 'synthetic-contact',
		journeyId: 'contact-directory',
		type: 'contact.profile.updated',
		idempotencyKey: 'profile:synthetic:1',
		occurredAt: at,
		payload: {
			profileVersion: 1,
			email: 'synthetic@example.test',
			firstName: null,
			holds: [],
		},
	} as const
	const post = vi.fn(
		async (_url: unknown, _init?: RequestInit) =>
			new Response(
				JSON.stringify({
					code: 'event-not-live',
					detail: 'synthetic migration boundary',
				}),
				{
					status: 409,
					headers: { 'content-type': 'application/problem+json' },
				},
			),
	)
	const outcome = await deliverOrThrow({
		event: { ...event, payload: { ...event.payload, holds: [] } },
		config: {
			ingestUrl: 'https://drovr.example.test/events',
			apiKey: 'synthetic-key',
		},
		clampAt: Date.parse(at),
		fetcher: post,
	})
	expect(outcome).toMatchObject({ status: 'deferred', httpStatus: 409 })
	expect(post).toHaveBeenCalledOnce()
	expect(JSON.parse(String(post.mock.calls[0]![1]?.body))).toEqual(event)
})
it('actual unrelated 409 with lookalike error text is never deferred', async () => {
	const event = {
		tenantId: 'org-aihero',
		contactId: 'synthetic-contact',
		journeyId: 'contact-directory',
		type: 'contact.profile.updated',
		idempotencyKey: 'profile:synthetic:1',
		occurredAt: at,
		payload: {
			profileVersion: 1,
			email: 'synthetic@example.test',
			firstName: null,
			holds: [],
		},
	} as const
	const outcome = await deliverDrovrShadowEvent({
		event: { ...event, payload: { ...event.payload, holds: [] } },
		config: {
			ingestUrl: 'https://drovr.example.test/events',
			apiKey: 'synthetic-key',
		},
		clampAt: Date.parse(at),
		fetcher: async () =>
			new Response(
				JSON.stringify({
					code: 'key-reuse',
					detail: 'event-not-live: synthetic prose',
				}),
				{
					status: 409,
					headers: { 'content-type': 'application/problem+json' },
				},
			),
	})
	expect(outcome).toMatchObject({ status: 'rejected', httpStatus: 409 })
})
