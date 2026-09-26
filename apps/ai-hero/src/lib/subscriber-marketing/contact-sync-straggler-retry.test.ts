import { describe, expect, it, vi } from 'vitest'

import {
	CONTACT_SYNC_RETRY_EVENT,
	STRAGGLER_RETRY_DELAY_MS,
	STRAGGLER_STUCK_AFTER_ATTEMPTS,
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
	return { step, deliver, warn, sent, birth }
}

describe('contact sync straggler retry', () => {
	it('schedules the same events, unchanged, at least 24 h out', () => {
		const request = contactSyncRetryRequest(deferred, 1, now)
		expect(STRAGGLER_RETRY_DELAY_MS).toBeGreaterThanOrEqual(24 * 3600_000)
		expect(request).toEqual({
			name: CONTACT_SYNC_RETRY_EVENT,
			ts: now + STRAGGLER_RETRY_DELAY_MS,
			data: { items: deferred, attempt: 1 },
		})
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
		})
		expect(receipt).toEqual({ status: 'rescheduled', deferred: 1, attempt: 3 })
		expect(h.sent).toEqual([
			{ id: 'reschedule', payload: contactSyncRetryRequest(deferred, 3, now) },
		])
	})

	it('while the flag is off (a drovr rollback) sends nothing and reschedules the same attempt', async () => {
		const h = harness({ accepted: 1, rejected: 0 })
		const receipt = await runContactSyncStragglerRetry({
			event: { data: { items: deferred, attempt: 2 } },
			step: h.step,
			env: {},
			now: () => now,
			deliver: h.deliver,
			warn: h.warn,
			birth: h.birth,
		})
		expect(h.deliver).not.toHaveBeenCalled()
		expect(receipt).toEqual({
			status: 'rescheduled',
			deferred: 1,
			attempt: 2,
			reason: 'AIH_DROVR_PROFILE_SYNC is not set',
		})
		expect(h.sent).toEqual([
			{ id: 'reschedule', payload: contactSyncRetryRequest(deferred, 2, now) },
		])
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
