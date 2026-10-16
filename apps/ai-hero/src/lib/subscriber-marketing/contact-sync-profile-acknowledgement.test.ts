import { expect, it, vi } from 'vitest'
import {
	buildContactProfileEvents,
	runContactProfileSync,
	type ContactProfileSnapshot,
} from './drovr-contact-profile-sync'
import {
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from './drovr-outbox'
import { proveContactProfileDelivery } from './contact-sync-profile-acknowledgement'

const at = '2026-10-16T12:00:00.000Z'
const target = 'synthetic-profile-proof-target'
const snapshot: ContactProfileSnapshot = {
	occurredAt: at,
	profile: { email: 'synthetic@example.test', firstName: null, holds: [] },
	links: [
		{
			journeyId: 'value-path-skills-course',
			emailKey: 'synthetic-email',
			issuedAt: at,
			expiresAt: '2027-01-01T00:00:00.000Z',
			variables: {},
			sendTimeFields: [],
		},
	],
	offers: [],
}
function fixture() {
	const events = buildContactProfileEvents({
		...snapshot,
		contactId: 'synthetic-contact',
		profileVersion: 3,
	})
	const rows: DrovrOutboxRow[] = events.map((event) => {
		const entry = outboxEntryForEvent(event, 'bulkDelta')
		const key = drovrOutboxDedupeKey(target, entry)
		return {
			...entry,
			id: key,
			dedupeKey: key,
			target,
			status: 'delivered',
			attempts: 0,
			lastStatus: 202,
			lastError: null,
			firstFailedAt: at,
			nextAttemptAt: at,
			lastAttemptAt: at,
			deliveredAt: at,
			releasedAt: null,
			createdAt: at,
		}
	})
	const read = vi.fn(async (_target: string, keys: readonly string[]) =>
		rows.filter((row) => keys.includes(row.dedupeKey)),
	)
	const prove = () =>
		proveContactProfileDelivery({
			events,
			contactId: 'synthetic-contact',
			profileVersion: 3,
			target,
			rows: read,
		})
	return { events, rows, read, prove }
}
it('requires a delivered profile and every frozen requested link, not just a positive sender count', async () => {
	const f = fixture()
	expect(await f.prove()).toBe(true)
	f.rows[1]!.status = 'pending'
	expect(await f.prove()).toBe(false)
})
it.each(['pending', 'deferred', 'held', 'rejected', 'superseded'] as const)(
	'never acknowledges a requested %s member',
	async (status) => {
		const f = fixture()
		f.rows[1]!.status = status
		expect(await f.prove()).toBe(false)
	},
)
it('refuses missing, duplicate, wrong-target and mismatched first-body evidence', async () => {
	for (const mutate of [
		(f: ReturnType<typeof fixture>) => {
			f.rows.pop()
		},
		(f: ReturnType<typeof fixture>) => {
			f.rows[1] = f.rows[0]!
		},
		(f: ReturnType<typeof fixture>) => {
			f.rows[0]!.target = 'another-target'
		},
		(f: ReturnType<typeof fixture>) => {
			f.rows[0]!.body = { ...f.events[0]!, contactId: 'another-contact' }
		},
		(f: ReturnType<typeof fixture>) => {
			f.rows[1]!.eventType = 'contact.profile.updated'
		},
		(f: ReturnType<typeof fixture>) => {
			f.rows[0]!.heldBatchBlocked = true
		},
		(f: ReturnType<typeof fixture>) => {
			f.rows[0]!.queueMetadataInvalid = true
		},
	]) {
		const f = fixture()
		mutate(f)
		expect(await f.prove()).toBe(false)
	}
})
it('an omitted profile or duplicate requested key cannot manufacture confirmation', async () => {
	const f = fixture()
	f.events.shift()
	expect(await f.prove()).toBe(false)
	const duplicate = fixture()
	duplicate.events.push(duplicate.events[0]!)
	expect(await duplicate.prove()).toBe(false)
})
it('ignores operator prose, even a throwing getter, when proving actual retained receipts', async () => {
	const f = fixture()
	Object.defineProperty(f.rows[0], 'lastError', {
		get: () => {
			throw new Error('prose became acknowledgement authority')
		},
	})
	expect(await f.prove()).toBe(true)
})
function producer(status: DrovrOutboxRow['status'], accepted: number) {
	const f = fixture()
	for (const row of f.rows) row.status = status
	const acknowledge = vi.fn(async () => {})
	const deliver = vi.fn(async () => ({ accepted, rejected: 0 }))
	const memo = new Map<string, unknown>()
	const step = {
		run: async (id: string, action: () => Promise<unknown>) => {
			if (!memo.has(id)) memo.set(id, await action())
			return memo.get(id)
		},
		sendEvent: vi.fn(),
	}
	const run = () =>
		runContactProfileSync({
			profileAckEnabled: async () => true,
			event: { data: { contactId: 'synthetic-contact', reason: 'reconcile' } },
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			step,
			readSnapshot: async () => snapshot,
			versionFor: async () => ({
				profileVersion: 3,
				since: at,
				acknowledged: false,
			}),
			onSendingJourney: async () => true,
			ownedPath: async () => undefined,
			birth: async () => {},
			deliver,
			acknowledge,
			proveDelivery: (input) =>
				proveContactProfileDelivery({ ...input, target, rows: f.read }),
		})
	return { ...f, acknowledge, deliver, run }
}
it.each([0, 2])('a proof-only old producer cannot turn %s sender counters into a registered ACK', async accepted => {
	const h = producer('pending', accepted)
	expect(await h.run()).toEqual({ status: 'ack-unavailable', profileVersion: 3, reason: 'registration-adapter-unavailable' })
	expect(h.deliver).not.toHaveBeenCalled()
	expect(h.acknowledge).not.toHaveBeenCalled()
})
it('even complete retained receipts in an old boolean adapter cannot retrofit an unregistered SDK identity', async () => {
	const h = producer('delivered', 0)
	expect(await h.prove()).toBe(true)
	expect(await h.run()).toMatchObject({ status: 'ack-unavailable', reason: 'registration-adapter-unavailable' })
	expect(h.acknowledge).not.toHaveBeenCalled()
	expect(h.deliver).not.toHaveBeenCalled()
})
// Actual fresh effect/failed-write/intervening-hold acceptance proofs now live
// in contact-sync-profile-ack-producer.test.ts and drovr-outbox-live.mysql.test.ts.
// They call the real frozen completion protocol, not a boolean proof→legacy NOW.
