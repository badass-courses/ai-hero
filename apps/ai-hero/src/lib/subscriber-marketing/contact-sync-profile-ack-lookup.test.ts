import { expect, it } from 'vitest'
import { buildContactProfileEvents } from './drovr-contact-profile-sync'
import { drovrOutboxDedupeKey, outboxEntryForEvent } from './drovr-outbox'
import { freezeProfileAckRequest } from './contact-sync-profile-ack'
import { lookupProfileAckReferences } from './contact-sync-profile-ack-lookup'
import { encodeHeldContinuationEnvelope } from './drovr-outbox-control'
import type { DrovrOutboxRow } from './drovr-outbox'
import { createMemoryContactProfileVersionStore } from './contact-profile-version'

const clock = '2032-01-01T00:00:00.000Z'
function fixture() {
	const target = 'synthetic-registration-lookup'
	const contactId = 'synthetic-registration-contact'
	const events = buildContactProfileEvents({
		contactId,
		profileVersion: 3,
		occurredAt: clock,
		profile: { email: 'synthetic@example.test', firstName: null, holds: [] },
		links: [
			{
				journeyId: 'value-path-skills-course',
				emailKey: 'synthetic-email',
				issuedAt: clock,
				expiresAt: '2032-05-01T00:00:00.000Z',
				variables: {},
				sendTimeFields: [],
			},
		],
		offers: [],
	})
	const rows: DrovrOutboxRow[] = events.map((event) => {
		const entry = outboxEntryForEvent(event, 'bulkDelta')
		const key = drovrOutboxDedupeKey(target, entry)
		return {
			...entry,
			id: key,
			dedupeKey: key,
			target,
			status: 'pending',
			attempts: 0,
			lastStatus: null,
			lastError: 'opaque prose is not authority',
			firstFailedAt: clock,
			nextAttemptAt: clock,
			lastAttemptAt: null,
			deliveredAt: null,
			releasedAt: null,
			createdAt: clock,
		}
	})
	const coordinator = freezeProfileAckRequest({
		target,
		contactId,
		profileVersion: 3,
		registeredAt: clock,
		rows,
	})
	for (const row of rows)
		row.heldContinuation = encodeHeldContinuationEnvelope({
			v: 1,
			profileAck:
				row.dedupeKey === coordinator.ref.coordinatorKey
					? coordinator
					: { v: 1, role: 'member', ref: coordinator.ref },
		})
	const args = {
		target,
		contactId,
		profileVersion: 3,
		request: { kind: 'delta' as const },
	}
	return {
		args,
		rows,
		coordinator,
		profile: rows.find((row) => row.eventType === 'contact.profile.updated')!,
		link: rows.find((row) => row.eventType === 'contact.links.issued')!,
	}
}
function database(results: (unknown[] | Error)[]) {
	let calls = 0
	const chain = {
		from: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: () => chain,
		for: async () => {
			const value = results[calls++] ?? []
			if (value instanceof Error) throw value
			return value
		},
	}
	return { db: { select: () => chain }, calls: () => calls }
}
it('returns only an actual retained original coordinator reference, including an OFF legacy probe', async () => {
	const f = fixture(),
		d = database([[f.profile]])
	const before = JSON.stringify(f.rows)
	expect(
		await lookupProfileAckReferences({
			...f.args,
			database: d.db,
			strict: false,
		}),
	).toEqual([f.coordinator.ref])
	expect(d.calls()).toBe(1)
	expect(JSON.stringify(f.rows)).toBe(before)
})
it('an orphaned retained member fences the original identity without rebuilding its coordinator', async () => {
	const f = fixture(),
		d = database([[], [f.link], []])
	const before = JSON.stringify(f.link)
	expect(
		await lookupProfileAckReferences({ ...f.args, database: d.db }),
	).toEqual([f.coordinator.ref])
	expect(d.calls()).toBe(3)
	expect(JSON.stringify(f.link)).toBe(before)
})
it('no original metadata returns no reference, not an invented requestId from current body or prose', async () => {
	const f = fixture()
	f.profile.heldContinuation = null
	f.profile.lastError = JSON.stringify(f.coordinator)
	const d = database([[f.profile], [], []])
	expect(
		await lookupProfileAckReferences({ ...f.args, database: d.db }),
	).toEqual([])
})
it('foreign metadata and changed native versions cannot hide as never registered', async () => {
	for (const foreign of ['contact', 'version', 'coordinator'] as const) {
		const f = fixture()
		if (foreign === 'contact') f.link.contactId = 'different-contact'
		if (foreign === 'version')
			(
				f.link.body as { payload: { profileVersion: number } }
			).payload.profileVersion = 9
		if (foreign === 'coordinator') {
			const ref = { ...f.coordinator.ref, coordinatorKey: 'a'.repeat(64) }
			f.link.heldContinuation = encodeHeldContinuationEnvelope({
				v: 1,
				profileAck: { v: 1, role: 'member', ref },
			})
		}
		const d = database([[], [f.link], []])
		await expect(
			lookupProfileAckReferences({ ...f.args, database: d.db, strict: false }),
		).rejects.toThrow('ProfileAckConflict:')
	}
})
it('a malformed retained native JSON body refuses rather than authorizing a replacement', async () => {
	const f = fixture()
	const broken = { ...f.link, body: '{broken' }
	const d = database([[], [broken]])
	await expect(
		lookupProfileAckReferences({ ...f.args, database: d.db }),
	).rejects.toThrow('ProfileAckConflict:')
})
it('a later required-column read fails closed; it is not absence or terminal expiry permission', async () => {
	const f = fixture()
	const missing = Object.assign(
		new Error("Unknown column 'AI_DrovrOutbox.heldContinuation'"),
		{ code: 'ER_BAD_FIELD_ERROR', errno: 1054 },
	)
	const d = database([[], missing])
	await expect(
		lookupProfileAckReferences({ ...f.args, database: d.db }),
	).rejects.toThrow('OutboxControl:')
	expect(d.calls()).toBe(2)
})
it('only an ordinary OFF old-schema probe tolerates missing columns, never another read failure', async () => {
	const f = fixture()
	const missing = Object.assign(
		new Error("Unknown column 'AI_DrovrOutbox.heldContinuation'"),
		{ code: 'ER_BAD_FIELD_ERROR', errno: 1054 },
	)
	const old = database([missing, missing, missing])
	expect(
		await lookupProfileAckReferences({
			...f.args,
			database: old.db,
			strict: false,
		}),
	).toEqual([])
	const failed = database([new Error('synthetic SQL read failure')])
	await expect(
		lookupProfileAckReferences({
			...f.args,
			database: failed.db,
			strict: false,
		}),
	).rejects.toThrow('synthetic SQL read failure')
})
it('does not truncate an oversized contact-indexed metadata result into absence', async () => {
	const f = fixture(),
		d = database([Array.from({ length: 1026 }, () => f.profile)])
	await expect(
		lookupProfileAckReferences({ ...f.args, database: d.db }),
	).rejects.toThrow('bounded scope')
})
it('new-code version provenance is opt-in, memoizable, and never repeated for an unchanged version', async () => {
	const store = createMemoryContactProfileVersionStore({
		now: () => clock,
		includeRegistrationCapability: true,
	})
	const first = await store.versionFor('synthetic-capability', 'v2:first')
	expect(first).toMatchObject({
		profileAckProtocol: 1,
		newlyIssued: true,
		profileVersion: 1,
	})
	const same = await store.versionFor('synthetic-capability', 'v2:first')
	expect(same.profileAckProtocol).toBe(1)
	expect(same).not.toHaveProperty('newlyIssued')
	await store.acknowledge('synthetic-capability', 1)
	expect(
		await store.versionFor('synthetic-capability', 'v2:first'),
	).toMatchObject({ acknowledgedAt: clock, acknowledged: true })
	expect(
		await store.versionFor('synthetic-capability', 'v2:changed'),
	).toMatchObject({ profileVersion: 2, newlyIssued: true })
	const legacy = createMemoryContactProfileVersionStore({ now: () => clock })
	expect(
		await legacy.versionFor('synthetic-legacy', 'v2:first'),
	).not.toHaveProperty('profileAckProtocol')
})
