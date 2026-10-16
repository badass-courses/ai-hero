import { describe, expect, it, vi } from 'vitest'
import { createMemoryContactProfileVersionStore } from './contact-profile-version'
import {
	buildContactProfileEvents,
	contactProfileContentHash,
	legacyContactProfileContentHash,
	runContactProfileSync,
	type ContactProfileSnapshot,
} from './drovr-contact-profile-sync'
import { currentOfferAfterProfile } from './contact-sync-offer-refresh'
import {
	queueContactSyncBulk,
	BULK_OUTBOX_QUEUE_WAIT_MS,
} from './contact-sync-bulk'
import {
	runContactSyncReconcile,
	type ContactSyncReconcilePorts,
	type ScannedContactEvent,
} from './contact-sync-reconcile'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import { drovrOutboxDedupeKey, outboxEntryForEvent, type DrovrOutboxEntry, type DrovrOutboxRow } from './drovr-outbox'
import { proveContactProfileDelivery } from './contact-sync-profile-acknowledgement'

const at = '2032-01-01T00:00:00.000Z'
const snapshot = (): ContactProfileSnapshot => ({
	occurredAt: at,
	profile: { email: 'learner@example.test', firstName: 'Test', holds: [] },
	links: [
		{
			journeyId: 'journey',
			emailKey: 'email',
			issuedAt: at,
			expiresAt: '2032-05-01T00:00:00.000Z',
			variables: { url: 'https://example.test/a' },
			sendTimeFields: [],
		},
	],
	offers: [
		{
			journeyId: 'offer',
			couponId: 'coupon-a',
			issuedAt: '2032-01-02T00:00:00.000Z',
			variables: { couponId: 'coupon-a' },
		},
	],
})
// Evaluated independently with the original b5a5d04b implementation, before
// offer issue-time metadata existed. Do not compute the seed with the helper
// under test: a shared hashing bug would otherwise make migration look green.
const originalLegacyDigest =
	'ac06e384acd7d5805d70e1893eb54fdcdf0397a8f63512467d08d60ca2a1cef5'
function harness() {
	let state = snapshot()
	let clock = at
	const versions = createMemoryContactProfileVersionStore({ now: () => clock })
	const target = 'synthetic-review-receiver'
	const receipts = new Map<string, DrovrOutboxRow>()
	const deliver = vi.fn(async (events: DrovrShadowEvent[]) => {
		// This fake receiver persists separate immutable delivered receipts;
		// producer confirmation reads those, never the aggregate counter.
		for (const event of events) {
			const entry = outboxEntryForEvent(event, event.type === 'contact.offer.issued' ? 'live' : event.idempotencyKey.includes(':restate:') ? 'bulkRestate' : 'bulkDelta')
			const key = drovrOutboxDedupeKey(target, entry)
			if (!receipts.has(key)) receipts.set(key, { ...entry, target, id: key, dedupeKey: key, status: 'delivered', attempts: 0, lastStatus: 202, lastError: null, firstFailedAt: clock, nextAttemptAt: clock, lastAttemptAt: clock, deliveredAt: clock, releasedAt: null, createdAt: clock })
		}
		return { accepted: events.length, rejected: 0 }
	})
	const sync = (reason: 'restate' | 'offer-issued' | 'journey-entered') =>
		runContactProfileSync({
			profileAckEnabled: async () => true,
			event: { data: { contactId: 'contact', reason } },
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			step: { run: async (_id, fn) => fn(), sendEvent: async () => {} },
			readSnapshot: async () => structuredClone(state),
			currentVersion: versions.currentFor,
			versionFor: versions.versionFor,
			acknowledge: versions.acknowledge,
			proveDelivery: input => proveContactProfileDelivery({ ...input, target, rows: async (_target, keys) => [...receipts.values()].filter(row => keys.includes(row.dedupeKey)) }),
			deliver,
			ownedPath: async () => undefined,
			onSendingJourney: async () => true,
			birth: async () => {},
		})
	return {
		versions,
		deliver,
		sync,
		state,
		clock: (value: string) => {
			clock = value
			state.occurredAt = value
		},
	}
}
describe('review regressions: real contact-sync decisions', () => {
	it('changes the offer key with the coupon and uses the coupon issue time, not profile since', () => {
		const s = snapshot()
		const build = () =>
			buildContactProfileEvents({
				contactId: 'contact',
				profileVersion: 4,
				...s,
			})
		const first = build().find(
			(event) => event.type === 'contact.offer.issued',
		)!
		s.offers[0] = {
			...s.offers[0]!,
			couponId: 'coupon-b',
			issuedAt: '2032-01-09T00:00:00.000Z',
		}
		const second = build().find(
			(event) => event.type === 'contact.offer.issued',
		)!
		expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
		expect(first.occurredAt).toBe('2032-01-02T00:00:00.000Z')
		expect(second.occurredAt).toBe('2032-01-09T00:00:00.000Z')
	})
	it('never captures an offer in a bump; a delayed post-profile refresh reads the newest coupon', async () => {
		const h = harness()
		await h.sync('journey-entered')
		expect(h.deliver.mock.calls[0]![0].map((event) => event.type)).toEqual([
			'contact.profile.updated',
			'contact.links.issued',
		])
		h.state.offers[0] = {
			...h.state.offers[0]!,
			couponId: 'coupon-new',
			issuedAt: '2032-01-09T00:00:00.000Z',
		}
		await h.sync('offer-issued')
		const fresh = await currentOfferAfterProfile(
			{ contactId: 'contact', profileVersion: 1 },
			{
				currentVersion: h.versions.currentFor,
				readOffer: async () => h.state.offers[0],
			},
		)
		expect(fresh).toEqual(h.deliver.mock.calls[1]![0])
		expect(fresh[0]!.idempotencyKey).toContain('coupon-new')
		expect(fresh[0]!.occurredAt).toBe('2032-01-09T00:00:00.000Z')
		await h.versions.versionFor('contact', 'different')
		expect(
			await currentOfferAfterProfile(
				{ contactId: 'contact', profileVersion: 1 },
				{
					currentVersion: h.versions.currentFor,
					readOffer: async () => h.state.offers[0],
				},
			),
		).toEqual([])
	})
	it('a deferred genuine coupon cannot acknowledge an unqueued profile through the straggler', async () => {
		const state = snapshot()
		const versions = createMemoryContactProfileVersionStore()
		await versions.versionFor('contact', contactProfileContentHash(state))
		const sends: unknown[] = []
		await runContactProfileSync({
			profileAckEnabled: async () => true,
			event: { data: { contactId: 'contact', reason: 'offer-issued' } },
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			step: {
				run: async (_id, fn) => fn(),
				sendEvent: async (_id, payload) => {
					sends.push(payload)
				},
			},
			readSnapshot: async () => state,
			currentVersion: versions.currentFor,
			versionFor: versions.versionFor,
			acknowledge: versions.acknowledge,
			ownedPath: async () => undefined,
			onSendingJourney: async () => true,
			birth: async () => {},
			deliver: async (events) => ({
				accepted: 0,
				rejected: 0,
				deferred: events.map((event) => ({
					event,
					reason: 'event-not-live' as const,
				})),
			}),
		})
		expect(
			(sends[0] as { data: { acknowledge?: unknown } }).data.acknowledge,
		).toBeUndefined()
		expect((await versions.currentFor('contact'))!.acknowledged).toBe(false)
	})
	it('a restatement of an unacknowledged version delivers its links before acknowledging', async () => {
		const h = harness()
		await h.versions.versionFor('contact', contactProfileContentHash(h.state))
		expect((await h.versions.currentFor('contact'))!.acknowledged).toBe(false)
		await h.sync('restate')
		expect(h.deliver.mock.calls[0]![0].map((event) => event.type)).toEqual([
			'contact.profile.updated',
			'contact.links.issued',
		])
		expect(h.deliver.mock.calls[0]![0][0]!.idempotencyKey).not.toContain(
			'restate',
		)
		expect((await h.versions.currentFor('contact'))!.acknowledged).toBe(true)
	})
	it('equal-version confirmation advances the store acknowledgement clock, preserving version and since', async () => {
		const h = harness()
		await h.sync('journey-entered')
		const before = await h.versions.currentFor('contact')
		h.clock('2032-02-05T00:00:00.000Z')
		await h.sync('restate')
		expect(await h.versions.currentFor('contact')).toMatchObject({
			profileVersion: before!.profileVersion,
			since: before!.since,
			acknowledgedAt: '2032-02-05T00:00:00.000Z',
		})
		expect(h.deliver.mock.calls[1]![0].map((event) => event.type)).toEqual([
			'contact.profile.updated',
		])
	})
	it('a live writer upgrades a matching legacy digest without a version bump or a POST', async () => {
		const h = harness()
		expect(legacyContactProfileContentHash(h.state)).toBe(originalLegacyDigest)
		await h.versions.versionFor('contact', originalLegacyDigest)
		await h.versions.acknowledge('contact', 1)
		expect(await h.sync('journey-entered')).toEqual({
			status: 'skipped',
			reason: 'hash-migrated',
		})
		expect(h.deliver).not.toHaveBeenCalled()
		expect(await h.versions.currentFor('contact')).toMatchObject({
			profileVersion: 1,
			contentHash: contactProfileContentHash(h.state),
			acknowledged: true,
		})
	})
	it('changed legacy values take a bump, never an equal-version restatement', async () => {
		const h = harness()
		await h.versions.versionFor('contact', originalLegacyDigest)
		await h.versions.acknowledge('contact', 1)
		h.state.profile.holds = ['support-intent']
		await h.sync('restate')
		expect((await h.versions.currentFor('contact'))!.profileVersion).toBe(2)
		expect(h.deliver.mock.calls[0]![0][0]!.idempotencyKey).toBe(
			'profile:contact:2',
		)
	})
	it('does not allow replay to take newly pre-captured rows while the normal worker owns them', async () => {
		const h = harness()
		const events = buildContactProfileEvents({
			contactId: 'contact',
			profileVersion: 1,
			...h.state,
			offers: [],
		})
		const capture = vi.fn(
			async (
				entries: readonly DrovrOutboxEntry[],
				_reason: unknown,
				_options?: { nextAttemptAt?: Date },
			) => ({ status: 'outboxed' as const, count: entries.length }),
		)
		const send = vi.fn(async () => undefined)
		await queueContactSyncBulk(
			events,
			{ capture, send },
			{ now: () => Date.parse(at) },
		)
		expect(capture.mock.calls[0]![2]!.nextAttemptAt!.getTime()).toBe(
			Date.parse(at) + BULK_OUTBOX_QUEUE_WAIT_MS,
		)
		expect(send.mock.invocationCallOrder[0]!).toBeGreaterThan(
			capture.mock.invocationCallOrder[0]!,
		)
	})
})

function reconcilePorts(
	fresh: ScannedContactEvent[],
	overlap: ScannedContactEvent[] = [],
) {
	const p = {
		now: () => new Date('2032-01-01T10:00:00.000Z'),
		readWatermark: async () => '2032-01-01T09:00:00.000Z',
		readProgress: async () => undefined,
		scanChanges: async ({ scope }: { scope: string }) =>
			scope === 'fresh' ? fresh : overlap,
		rotatedContacts: async () => [],
		syncContact: vi.fn(async (_id: string) => 'sent' as const),
		syncOffer: vi.fn(async (_id: string) => 'sent' as const),
		resendStops: vi.fn(async () => {}),
		heartbeat: vi.fn(async (_through: string) => {}),
		writeWatermark: vi.fn(async (_through: string) => {}),
	}
	return p satisfies ContactSyncReconcilePorts
}
it('reconciles coupon rows live and refuses to claim a failed offer, including late writes', async () => {
	const row = {
		id: 'row',
		contactId: 'contact',
		eventType: 'coupon.issued',
		occurredAt: '2032-01-01T09:10:00.000Z',
	}
	const p = reconcilePorts([row])
	await runContactSyncReconcile(p)
	expect(p.syncContact).not.toHaveBeenCalled()
	expect(p.syncOffer).toHaveBeenCalledWith('contact')
	p.syncOffer.mockRejectedValue(new Error('synthetic offer failure'))
	const failed = await runContactSyncReconcile(p)
	expect(failed.status).toBe('partial')
	expect(failed.syncedThrough).toBe('2032-01-01T09:09:59.999Z')
	const late = reconcilePorts(
		[],
		[{ ...row, occurredAt: '2032-01-01T08:00:00.000Z' }],
	)
	late.syncOffer.mockRejectedValue(new Error('late offer failure'))
	await expect(runContactSyncReconcile(late)).rejects.toThrow(
		'late offer failure',
	)
	expect(late.heartbeat).not.toHaveBeenCalled()
})
it('generated nonempty delta scans cover both repairs and emit honest bounded heartbeats', async () => {
	for (let seed = 1; seed <= 20; seed++) {
		const rows = Array.from({ length: 35 }, (_, i) => ({
			id: `row-${i}`,
			contactId: `contact-${(i * seed) % 9}`,
			eventType: i % 3 ? 'profile.changed' : 'coupon.issued',
			occurredAt: new Date(
				Date.parse('2032-01-01T09:01:00.000Z') + i * 1000,
			).toISOString(),
		}))
		const p = reconcilePorts(rows)
		const receipt = await runContactSyncReconcile(p)
		expect(new Set(p.syncContact.mock.calls.map(([id]) => id))).toEqual(
			new Set(
				rows
					.filter((row) => row.eventType !== 'coupon.issued')
					.map((row) => row.contactId),
			),
		)
		expect(new Set(p.syncOffer.mock.calls.map(([id]) => id))).toEqual(
			new Set(
				rows
					.filter((row) => row.eventType === 'coupon.issued')
					.map((row) => row.contactId),
			),
		)
		expect(p.heartbeat).toHaveBeenCalledWith(receipt.syncedThrough)
		expect(receipt.syncedThrough).toBe('2032-01-01T09:58:00.000Z')
	}
})
