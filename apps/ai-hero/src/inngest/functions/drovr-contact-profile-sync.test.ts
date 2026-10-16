import { describe, expect, it, vi } from 'vitest'

import type { ContactProfileSnapshot } from '@/lib/subscriber-marketing/drovr-contact-profile-sync'

import { contactSyncRetryRequest } from '@/lib/subscriber-marketing/contact-sync-straggler-retry'
import {
	contactProfileContentHash,
	legacyContactProfileContentHash,
	runContactProfileSync,
} from '@/lib/subscriber-marketing/drovr-contact-profile-sync'
import { createMemoryContactProfileVersionStore } from '@/lib/subscriber-marketing/contact-profile-version'
import type { DeferredDrovrEvent } from '@/lib/subscriber-marketing/drovr-shadow-delivery'
import type { DrovrShadowEvent } from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import { drovrOutboxDedupeKey, outboxEntryForEvent, type DrovrOutboxRow } from '@/lib/subscriber-marketing/drovr-outbox'
import { proveContactProfileDelivery } from '@/lib/subscriber-marketing/contact-sync-profile-acknowledgement'

const now = Date.parse('2026-09-27T12:00:00.000Z')

const snapshot: ContactProfileSnapshot = {
	occurredAt: '2026-09-26T17:00:00.000Z',
	profile: { email: 'learner@example.test', firstName: 'Ada', holds: [] },
	links: [],
	offers: [],
}

function harness(
	overrides: {
		env?: Record<string, string>
		contactId?: string
		valuePathSlug?: string
		snapshot?: ContactProfileSnapshot | undefined
		delivered?:
			| {
					accepted: number
					rejected: number
					deferred?: DeferredDrovrEvent[]
			  }
			| 'not-configured'
		onSendingJourney?: boolean
		reason?: 'journey-entered' | 'offer-issued' | 'reconcile'
		acknowledged?: boolean
	} = {},
) {
	const order: string[] = []
	const sent: { id: string; payload: unknown }[] = []
	const step = {
		run: vi.fn(async (id: string, callback: () => Promise<unknown>) => {
			order.push(id)
			return callback()
		}),
		sendEvent: vi.fn(async (id: string, payload: unknown) => {
			order.push(id)
			sent.push({ id, payload })
		}),
	}
	const readSnapshot = vi.fn(async () =>
		'snapshot' in overrides ? overrides.snapshot : snapshot,
	)
	const versionFor = vi.fn(async () => ({
		profileVersion: 4,
		since: '2026-09-26T16:00:00.000Z',
		acknowledged: overrides.acknowledged ?? false,
	}))
	const acknowledge = vi.fn(async () => {})
	const deliver = vi.fn(async (events: DrovrShadowEvent[]) =>
		'delivered' in overrides
			? overrides.delivered!
			: { accepted: events.length, rejected: 0 },
	)
	// Model immutable receiver receipts separately from aggregate outcomes.
	// A queue's zero counters create no delivered row; cold/retry history
	// retains the first body and confirms only specifically accepted members.
	const proveDelivery = vi.fn(async (input: { contactId: string; profileVersion: number; events: DrovrShadowEvent[] }) => {
		const target = 'synthetic-profile-function'
		const rows = new Map<string, DrovrOutboxRow>()
		for (let index = 0; index < deliver.mock.calls.length; index++) {
			const events = deliver.mock.calls[index]![0]
			const result = await deliver.mock.results[index]!.value
			for (const event of events) {
				const entry = outboxEntryForEvent(event, 'bulkDelta')
				const key = drovrOutboxDedupeKey(target, entry)
				if (!rows.has(key)) rows.set(key, { ...entry, id: key, target, dedupeKey: key, status: 'pending', attempts: 0, lastStatus: null, lastError: null, firstFailedAt: event.occurredAt, nextAttemptAt: event.occurredAt, lastAttemptAt: null, deliveredAt: null, releasedAt: null, createdAt: event.occurredAt })
			}
			if (result === 'not-configured' || result.rejected) continue
			const accepted = events.filter(event => !result.deferred?.some((item: DeferredDrovrEvent) => item.event.idempotencyKey === event.idempotencyKey))
			if (result.accepted !== accepted.length) continue
			for (const event of accepted) {
				const row = rows.get(drovrOutboxDedupeKey(target, outboxEntryForEvent(event, 'bulkDelta')))!
				row.status = 'delivered'; row.lastStatus = 202; row.deliveredAt = new Date(now).toISOString()
			}
		}
		return proveContactProfileDelivery({ ...input, target, rows: async (_target, keys) => [...rows.values()].filter(row => keys.includes(row.dedupeKey)) })
	})
	const ownedPath = vi.fn(async () => 'ai-hero-skills-workflow')
	const onSendingJourney = vi.fn(async () => overrides.onSendingJourney ?? true)
	const birth = vi.fn(async () => {})
	const run = () =>
		runContactProfileSync({
			profileAckEnabled: async () => true,
			event: {
				data: {
					contactId: overrides.contactId ?? 'contact-1',
					reason: overrides.reason ?? 'journey-entered',
					...('valuePathSlug' in overrides
						? overrides.valuePathSlug
							? { valuePathSlug: overrides.valuePathSlug }
							: {}
						: { valuePathSlug: 'ai-hero-skills-workflow' }),
				},
			},
			step,
			env: overrides.env ?? { AIH_DROVR_PROFILE_SYNC: 'true' },
			readSnapshot,
			versionFor,
			currentVersion: versionFor,
			deliver,
			ownedPath,
			onSendingJourney,
			now: () => now,
			birth,
			acknowledge,
			proveDelivery,
		})
	return {
		sent,
		birth,
		acknowledge,
		run,
		step,
		readSnapshot,
		versionFor,
		deliver,
		ownedPath,
		onSendingJourney,
		order,
	}
}

describe('drovr contact profile sync function', () => {
	it('does nothing at all while the flag is off', async () => {
		const h = harness({ env: {} })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'AIH_DROVR_PROFILE_SYNC is not set',
		})
		expect(h.readSnapshot).not.toHaveBeenCalled()
		expect(h.step.run).not.toHaveBeenCalled()
		expect(h.deliver).not.toHaveBeenCalled()
	})

	it('never profiles a synthetic test principal', async () => {
		const h = harness({ contactId: 'synthetic_abc' })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'synthetic-principal',
		})
		expect(h.readSnapshot).not.toHaveBeenCalled()
	})

	it('pushes nothing for a contact on no drovr sending journey (drovr would refuse it)', async () => {
		// The contract: profile, links and offer events only for contacts
		// with a drovr sending journey; drovr migrates only those to v2.
		const h = harness({ onSendingJourney: false })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'no-sending-journey',
		})
		expect(h.onSendingJourney).toHaveBeenCalledWith('contact-1')
		expect(h.order).toEqual(['sending-journey'])
		expect(h.readSnapshot).not.toHaveBeenCalled()
		expect(h.versionFor).not.toHaveBeenCalled()
		expect(h.deliver).not.toHaveBeenCalled()
	})

	it('refused as event-not-live: schedules the same events for after the straggler pass, and answers deferred', async () => {
		// Contract §4: nothing was recorded and the key is unconsumed, so the
		// same event is retried unchanged; §3: it does not hold the watermark.
		const profileEvent = {
			tenantId: 'org-aihero' as const,
			contactId: 'contact-1',
			journeyId: 'contact-directory' as const,
			type: 'contact.profile.updated' as const,
			occurredAt: '2026-09-26T16:00:00.000Z',
			idempotencyKey: 'profile:contact-1:4',
		}
		const deferred: DeferredDrovrEvent[] = [
			{ event: profileEvent, reason: 'event-not-live' },
		]
		const h = harness({ delivered: { accepted: 0, rejected: 0, deferred } })
		await expect(h.run()).resolves.toEqual({
			status: 'deferred',
			reason: 'event-not-live',
			profileVersion: 4,
			deferred: 1,
		})
		expect(h.sent).toEqual([
			{
				id: 'defer-refused',
				// Nothing was rejected, so the retry may vouch for version 4.
				payload: contactSyncRetryRequest(deferred, 1, now, {
					contactId: 'contact-1',
					profileVersion: 4,
				}),
			},
		])
		// That actor exists, it is on v1: never a birth.
		expect(h.birth).not.toHaveBeenCalled()
	})

	it('refused as cold-start-unhandled: births the directory actor, then pushes again and answers sent', async () => {
		const profileEvent = {
			tenantId: 'org-aihero' as const,
			contactId: 'contact-1',
			journeyId: 'contact-directory' as const,
			type: 'contact.profile.updated' as const,
			occurredAt: '2026-09-26T16:00:00.000Z',
			idempotencyKey: 'profile:contact-1:4',
		}
		const cold: DeferredDrovrEvent[] = [
			{ event: profileEvent, reason: 'cold-start-unhandled' },
		]
		const h = harness()
		h.deliver
			.mockResolvedValueOnce({ accepted: 0, rejected: 0, deferred: cold })
			.mockResolvedValueOnce({ accepted: 1, rejected: 0 })
		await expect(h.run()).resolves.toMatchObject({
			status: 'sent',
			profileVersion: 4,
			accepted: 1,
		})
		expect(h.birth).toHaveBeenCalledWith(['contact-1'])
		expect(h.deliver).toHaveBeenNthCalledWith(2, [profileEvent])
		expect(h.order.slice(-4)).toEqual([
			'delta-deliver-profile',
			expect.stringMatching(/^paced-birth:[a-f0-9]{64}$/),
			expect.stringMatching(/^paced-redeliver:[a-f0-9]{64}$/),
			'delta-acknowledge-version',
		])
		expect(h.sent).toEqual([])
	})

	it('pushes nothing for a contact with no email (drovr would ignore it as malformed)', async () => {
		// Contract §2 wants a non-empty email; with no profile drovr falls
		// back to live personalize, which holds the contact.
		const h = harness({
			snapshot: {
				...snapshot,
				profile: {
					email: '',
					firstName: null,
					holds: ['contact-email-missing'],
				},
			},
		})
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'contact-email-missing',
		})
		expect(h.versionFor).not.toHaveBeenCalled()
		expect(h.deliver).not.toHaveBeenCalled()
	})

	it('a live writer skips an unchanged version drovr already acknowledged', async () => {
		// The hawk (2026-09-27): signup, owner assignment and the like each
		// re-pushed the same version; drovr deduped them, 2–4× the calls.
		for (const reason of ['journey-entered', 'reconcile'] as const) {
			const h = harness({ reason, acknowledged: true })
			await expect(h.run()).resolves.toEqual({
				status: 'skipped',
				reason: 'unchanged',
			})
			expect(h.deliver).not.toHaveBeenCalled()
		}
	})

	it('the delta reconcile skips unchanged profiles; monthly restatement is separate', async () => {
		const h = harness({ reason: 'reconcile', acknowledged: true })
		await expect(h.run()).resolves.toMatchObject({ status: 'skipped', reason: 'unchanged' })
		expect(h.deliver).not.toHaveBeenCalled()
	})

	it('acknowledges only a full accept', async () => {
		const accepted = harness()
		await accepted.run()
		expect(accepted.acknowledge).toHaveBeenCalledWith('contact-1', 4)
		expect(accepted.order.at(-1)).toBe('delta-acknowledge-version')

		const rejected = harness({ delivered: { accepted: 0, rejected: 1 } })
		await rejected.run()
		expect(rejected.acknowledge).not.toHaveBeenCalled()

		const refused = harness({
			delivered: {
				accepted: 0,
				rejected: 0,
				deferred: [
					{
						event: {
							tenantId: 'org-aihero',
							contactId: 'contact-1',
							journeyId: 'contact-directory',
							type: 'contact.profile.updated',
							occurredAt: '2026-09-26T16:00:00.000Z',
							idempotencyKey: 'profile:contact-1:4',
						},
						reason: 'event-not-live',
					},
				],
			},
		})
		await refused.run()
		expect(refused.acknowledge).not.toHaveBeenCalled()
	})

	it('pushes again after a failed push: an offer is never skipped unless drovr took it', async () => {
		// With the real store: a failed first push leaves the version
		// unacknowledged, so the next offer-issued request still delivers.
		const store = createMemoryContactProfileVersionStore()
		await store.versionFor('contact-1', contactProfileContentHash(snapshot))
		const offerSnapshot = { ...snapshot, offers: [{ journeyId: 'journey', couponId: 'coupon', variables: {} }] }
		const deliver = vi
			.fn()
			.mockRejectedValueOnce(new Error('drovr 503'))
			.mockResolvedValueOnce({ accepted: 1, rejected: 0 })
			.mockResolvedValueOnce({ accepted: 1, rejected: 0 })
		const run = () =>
			runContactProfileSync({
				profileAckEnabled: async () => true,
				event: { data: { contactId: 'contact-1', reason: 'offer-issued' } },
				step: {
					run: async (_id, callback) => callback(),
					sendEvent: async () => undefined,
				},
				env: { AIH_DROVR_PROFILE_SYNC: 'true' },
				readSnapshot: async () => offerSnapshot,
				currentVersion: (contactId) => store.currentFor(contactId),
				versionFor: (contactId, hash) => store.versionFor(contactId, hash),
				acknowledge: (contactId, version) =>
					store.acknowledge(contactId, version),
				deliver,
				ownedPath: async () => undefined,
				onSendingJourney: async () => true,
				birth: async () => undefined,
			})
		await expect(run()).rejects.toThrow('drovr 503')
		await expect(run()).resolves.toMatchObject({ status: 'sent' })
		// Coupon facts retain a stable key; retries never emit a profile or link.
		await expect(run()).resolves.toMatchObject({ status: 'sent', profileVersion: 1 })
		expect(deliver).toHaveBeenCalledTimes(3)
		for (const [events] of deliver.mock.calls) expect(events.every((event: { type: string }) => event.type === 'contact.offer.issued')).toBe(true)
	})

	it('spends no version on a contact ai-hero does not have', async () => {
		const h = harness({ snapshot: undefined })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'contact-missing',
		})
		expect(h.versionFor).not.toHaveBeenCalled()
		expect(h.deliver).not.toHaveBeenCalled()
	})

	it('reads, bumps once, then delivers and answers sent only once drovr took it', async () => {
		const h = harness()
		await expect(h.run()).resolves.toEqual({
			status: 'sent',
			profileVersion: 4,
			links: 0,
			offers: 0,
			accepted: 1,
			rejected: 0,
		})
		expect(h.order).toEqual([
			'sending-journey',
			'read-profile',
			'review-profile-version',
			'delta-deliver-profile',
			'delta-acknowledge-version',
		])
		expect(h.readSnapshot).toHaveBeenCalledWith({
			contactId: 'contact-1',
			valuePathSlug: 'ai-hero-skills-workflow',
		})
		expect(h.versionFor).toHaveBeenCalledTimes(1)
		expect(h.deliver).toHaveBeenCalledWith([
			expect.objectContaining({
				tenantId: 'org-aihero',
				journeyId: 'contact-directory',
				type: 'contact.profile.updated',
				idempotencyKey: 'profile:contact-1:4',
			}),
		])
	})

	it('versions by content: the hash covers what drovr stores, and every event carries when that version was set', async () => {
		const h = harness()
		await h.run()
		expect(h.versionFor).toHaveBeenCalledWith(
			'contact-1',
			contactProfileContentHash(snapshot),
			legacyContactProfileContentHash(snapshot),
		)
		expect(h.deliver).toHaveBeenCalledWith([
			expect.objectContaining({
				idempotencyKey: 'profile:contact-1:4',
				occurredAt: '2026-09-26T16:00:00.000Z',
			}),
		])
	})

	it('reports drovr not configured, so the reconcile never counts it as pushed', async () => {
		const h = harness({ delivered: 'not-configured' })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'drovr-not-configured',
		})
	})

	it('reports a rejection, so the reconcile never counts a refused profile as pushed', async () => {
		const h = harness({ delivered: { accepted: 2, rejected: 1 } })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'drovr-rejected',
		})
	})

	it('issues the path drovr owns for the contact when the request names none', async () => {
		const h = harness({ valuePathSlug: undefined })
		await h.run()
		expect(h.ownedPath).toHaveBeenCalledWith('contact-1')
		expect(h.readSnapshot).toHaveBeenCalledWith({
			contactId: 'contact-1',
			valuePathSlug: 'ai-hero-skills-workflow',
		})
	})
})
