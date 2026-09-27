import { describe, expect, it, vi } from 'vitest'

import {
	CONTACT_SYNC_RETRY_EVENT,
	STRAGGLER_STUCK_AFTER_ATTEMPTS,
	stragglerRetryDelayMs,
	contactSyncRetryRequest,
	createDirectoryBirth,
	directoryBirthEvents,
	runContactSyncStragglerRetry,
} from './contact-sync-straggler-retry'
import type { DeferredDrovrEvent } from './drovr-shadow-delivery'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const now = Date.parse('2026-09-27T12:00:00.000Z')
const profile: DrovrShadowEvent = {
	tenantId: 'org-aihero',
	contactId: 'c1',
	journeyId: 'contact-directory',
	type: 'contact.profile.updated',
	occurredAt: '2026-09-26T17:00:00.000Z',
	idempotencyKey: 'profile:c1:3',
	payload: {
		profileVersion: 3,
		email: 'a@example.test',
		firstName: null,
		holds: [],
	},
}
const deferred: DeferredDrovrEvent[] = [
	{ event: profile, reason: 'event-not-live' },
]

function harness(delivered: {
	accepted: number
	rejected: number
	deferred?: DeferredDrovrEvent[]
}) {
	const sent: { id: string; payload: unknown }[] = []
	const step = {
		run: vi.fn(async (_id: string, callback: () => Promise<unknown>) =>
			callback(),
		),
		sendEvent: vi.fn(async (id: string, payload: unknown) => {
			sent.push({ id, payload })
		}),
	}
	const deliver = vi.fn(async () => delivered)
	const warn = vi.fn()
	const birth = vi.fn(async () => {})
	const acknowledge = vi.fn(async () => {})
	return { step, deliver, warn, sent, birth, acknowledge }
}

describe('contact sync straggler retry', () => {
	it('schedules the same events, unchanged: 1 h after the refusal, then every 2 h (contract §4, 2026-09-27)', () => {
		// drovr's straggler pass runs every 2 h, so the worst case is ~4 h.
		expect(stragglerRetryDelayMs(1)).toBe(60 * 60_000)
		expect(stragglerRetryDelayMs(2)).toBe(2 * 60 * 60_000)
		expect(stragglerRetryDelayMs(9)).toBe(2 * 60 * 60_000)
		expect(contactSyncRetryRequest(deferred, 1, now)).toEqual({
			name: CONTACT_SYNC_RETRY_EVENT,
			id: expect.stringMatching(/^contact-sync-retry:1:[0-9a-f]{64}$/),
			ts: now + 60 * 60_000,
			data: { items: deferred, attempt: 1 },
		})
		expect(contactSyncRetryRequest(deferred, 3, now).ts).toBe(
			now + 2 * 60 * 60_000,
		)
	})

	it('keys the request by its events: one pending retry per contact, however often it changes', () => {
		// A late joiner re-pushes its unchanged version on every change (same
		// idempotency keys); Inngest drops a same-id send within 24 h, so a
		// second change adds no second retry (the hawk, 2026-09-27).
		const second: DeferredDrovrEvent = {
			event: { ...profile, idempotencyKey: 'links:c1:vp:email-0:t' },
			reason: 'event-not-live',
		}
		const first = contactSyncRetryRequest([deferred[0]!, second], 1, now)
		const later = contactSyncRetryRequest(
			[second, deferred[0]!],
			1,
			now + 45 * 60_000,
		)
		expect(later.id).toBe(first.id)
		// Different events, or the retry's own next attempt, are new requests.
		expect(contactSyncRetryRequest(deferred, 1, now).id).not.toBe(first.id)
		expect(contactSyncRetryRequest([deferred[0]!, second], 2, now).id).not.toBe(
			first.id,
		)
	})

	it('re-sends the same events with the same keys, and stops once drovr takes them', async () => {
		const h = harness({ accepted: 1, rejected: 0 })
		const receipt = await runContactSyncStragglerRetry({
			event: { data: { items: deferred, attempt: 1 } },
			step: h.step,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			now: () => now,
			deliver: h.deliver,
			warn: h.warn,
			birth: h.birth,
			acknowledge: h.acknowledge,
		})
		expect(h.deliver).toHaveBeenCalledWith([profile])
		expect(receipt).toEqual({ status: 'delivered', accepted: 1, rejected: 0 })
		expect(h.sent).toEqual([])
	})

	it('refused again: schedules the next day with the next attempt, never drops', async () => {
		const h = harness({ accepted: 0, rejected: 0, deferred })
		const receipt = await runContactSyncStragglerRetry({
			event: { data: { items: deferred, attempt: 2 } },
			step: h.step,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			now: () => now,
			deliver: h.deliver,
			warn: h.warn,
			birth: h.birth,
			acknowledge: h.acknowledge,
		})
		expect(receipt).toEqual({ status: 'rescheduled', deferred: 1, attempt: 3 })
		expect(h.sent).toEqual([
			{ id: 'reschedule', payload: contactSyncRetryRequest(deferred, 3, now) },
		])
	})

	it('while the flag is off (a drovr rollback) sends nothing and reschedules as the next attempt', async () => {
		// The next attempt, never the same one: its id is new, so Inngest's
		// 24 h same-id dedupe (#318) can't drop the reschedule, which a 2 h
		// cadence would otherwise hit.
		const h = harness({ accepted: 1, rejected: 0 })
		const receipt = await runContactSyncStragglerRetry({
			event: { data: { items: deferred, attempt: 2 } },
			step: h.step,
			env: {},
			now: () => now,
			deliver: h.deliver,
			warn: h.warn,
			birth: h.birth,
			acknowledge: h.acknowledge,
		})
		expect(h.deliver).not.toHaveBeenCalled()
		expect(receipt).toEqual({
			status: 'rescheduled',
			deferred: 1,
			attempt: 3,
			reason: 'AIH_DROVR_PROFILE_SYNC is not set',
		})
		expect(h.sent).toEqual([
			{ id: 'reschedule', payload: contactSyncRetryRequest(deferred, 3, now) },
		])
	})

	it('warns once a contact has been refused for about a day', () => {
		// 1 h + 11 × 2 h ≈ 23 h at the 12th attempt.
		expect(STRAGGLER_STUCK_AFTER_ATTEMPTS).toBe(12)
	})

	it('warns when a contact stays refused for a week', async () => {
		const h = harness({ accepted: 0, rejected: 0, deferred })
		await runContactSyncStragglerRetry({
			event: {
				data: { items: deferred, attempt: STRAGGLER_STUCK_AFTER_ATTEMPTS },
			},
			step: h.step,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			now: () => now,
			deliver: h.deliver,
			warn: h.warn,
			birth: h.birth,
			acknowledge: h.acknowledge,
		})
		expect(h.warn).toHaveBeenCalledWith(
			'drovr.contact_sync.straggler_stuck',
			expect.objectContaining({
				attempt: STRAGGLER_STUCK_AFTER_ATTEMPTS,
				idempotencyKeys: ['profile:c1:3'],
			}),
		)
	})

	it('cold-start-unhandled: births the directory actor, then retries the push at once', async () => {
		const cold: DeferredDrovrEvent[] = [
			{ event: profile, reason: 'cold-start-unhandled' },
		]
		const h = harness({ accepted: 0, rejected: 0, deferred: cold })
		h.deliver
			.mockResolvedValueOnce({ accepted: 0, rejected: 0, deferred: cold })
			.mockResolvedValueOnce({ accepted: 1, rejected: 0 })
		const receipt = await runContactSyncStragglerRetry({
			event: { data: { items: cold, attempt: 1 } },
			step: h.step,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			now: () => now,
			deliver: h.deliver,
			warn: h.warn,
			birth: h.birth,
			acknowledge: h.acknowledge,
		})
		expect(h.birth).toHaveBeenCalledWith(['c1'])
		expect(h.deliver).toHaveBeenNthCalledWith(2, [profile])
		expect(receipt).toEqual({ status: 'delivered', accepted: 1, rejected: 0 })
		expect(h.sent).toEqual([])
	})

	it('never births for event-not-live: that actor exists, it is on v1', async () => {
		const h = harness({ accepted: 0, rejected: 0, deferred })
		await runContactSyncStragglerRetry({
			event: { data: { items: deferred, attempt: 1 } },
			step: h.step,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			now: () => now,
			deliver: h.deliver,
			warn: h.warn,
			birth: h.birth,
			acknowledge: h.acknowledge,
		})
		expect(h.birth).not.toHaveBeenCalled()
		expect(h.deliver).toHaveBeenCalledTimes(1)
	})
})

describe('the directory birth (contract §4)', () => {
	it('is exactly what the seed and the live feed send', () => {
		expect(
			directoryBirthEvents({
				contact: {
					id: 'c1',
					lifecycle: 'nurture-ready',
					isProvisional: false,
					createdAt: '2026-09-01T10:00:00.000Z',
					updatedAt: '2026-09-02T10:00:00.000Z',
				},
				kitSubscriberId: '4242',
			}),
		).toEqual([
			{
				tenantId: 'org-aihero',
				journeyId: 'contact-directory',
				contactId: 'c1',
				type: 'contact.created',
				occurredAt: '2026-09-01T10:00:00.000Z',
				idempotencyKey: 'directory:seed:c1',
				payload: {
					createdAt: '2026-09-01T10:00:00.000Z',
					lifecycle: 'provisional',
					source: 'ai-hero',
					kitSubscriberId: '4242',
					sourceLifecycle: 'nurture-ready',
				},
			},
		])
	})

	it('names a Kit subscriber only when the contact has one', () => {
		const [birth] = directoryBirthEvents({
			contact: {
				id: 'c2',
				lifecycle: 'nurture-ready',
				isProvisional: true,
				createdAt: '2026-09-01T10:00:00.000Z',
				updatedAt: '2026-09-01T10:00:00.000Z',
			},
		})
		expect(birth?.payload).not.toHaveProperty('kitSubscriberId')
	})
})

describe('createDirectoryBirth', () => {
	it('births each contact it can read, in one delivery, and skips one it cannot', async () => {
		const deliver = vi.fn(async () => ({ accepted: 1, rejected: 0 }))
		const birth = createDirectoryBirth({
			findContactById: async (id) =>
				id === 'c1'
					? {
							id: 'c1',
							lifecycle: 'nurture-ready',
							isProvisional: false,
							createdAt: '2026-09-01T10:00:00.000Z',
							updatedAt: '2026-09-01T10:00:00.000Z',
						}
					: undefined,
			kitSubscriberIdFor: async () => '4242',
			deliver,
		})
		await birth(['c1', 'gone'])
		expect(deliver).toHaveBeenCalledTimes(1)
		expect(deliver).toHaveBeenCalledWith([
			expect.objectContaining({
				contactId: 'c1',
				idempotencyKey: 'directory:seed:c1',
				payload: expect.objectContaining({ kitSubscriberId: '4242' }),
			}),
		])
	})

	it('delivers nothing when no contact can be read', async () => {
		const deliver = vi.fn()
		await createDirectoryBirth({
			findContactById: async () => undefined,
			kitSubscriberIdFor: async () => undefined,
			deliver,
		})(['gone'])
		expect(deliver).not.toHaveBeenCalled()
	})
})

describe('acknowledging a version the straggler retry lands (Macroscope on #319)', () => {
	const ack = { contactId: 'c1', profileVersion: 3 }
	const run = (
		h: ReturnType<typeof harness>,
		data: Record<string, unknown>,
		env: Record<string, string> = { AIH_DROVR_PROFILE_SYNC: 'true' },
	) =>
		runContactSyncStragglerRetry({
			event: { data: { items: deferred, attempt: 1, ...data } as never },
			step: h.step,
			env,
			now: () => now,
			deliver: h.deliver,
			warn: h.warn,
			birth: h.birth,
			acknowledge: h.acknowledge,
		})

	it('carries the version to acknowledge, and acknowledges it once drovr takes every event', async () => {
		expect(contactSyncRetryRequest(deferred, 1, now, ack).data).toEqual({
			items: deferred,
			attempt: 1,
			acknowledge: ack,
		})
		const h = harness({ accepted: 1, rejected: 0 })
		await run(h, { acknowledge: ack })
		expect(h.acknowledge).toHaveBeenCalledWith('c1', 3)
	})

	it('does not acknowledge a rejection, or a request without a version to vouch for', async () => {
		const rejected = harness({ accepted: 0, rejected: 1 })
		await run(rejected, { acknowledge: ack })
		expect(rejected.acknowledge).not.toHaveBeenCalled()
		const plain = harness({ accepted: 1, rejected: 0 })
		await run(plain, {})
		expect(plain.acknowledge).not.toHaveBeenCalled()
	})

	it('carries it forward on every reschedule (refused again, or the flag off)', async () => {
		const refused = harness({ accepted: 0, rejected: 0, deferred })
		await run(refused, { acknowledge: ack })
		expect(refused.acknowledge).not.toHaveBeenCalled()
		expect(refused.sent).toEqual([
			{
				id: 'reschedule',
				payload: contactSyncRetryRequest(deferred, 2, now, ack),
			},
		])
		const off = harness({ accepted: 1, rejected: 0 })
		await run(off, { acknowledge: ack }, {})
		expect(off.sent).toEqual([
			{
				id: 'reschedule',
				payload: contactSyncRetryRequest(deferred, 2, now, ack),
			},
		])
	})
})
