import { describe, expect, it, vi } from 'vitest'
import type { drovrOutbox } from '@/db/drovr-outbox-schema'
import { guardProfileAckWorkerAdmission } from './contact-sync-profile-ack-admission'
import { freezeProfileAckRequest } from './contact-sync-profile-ack'
import { buildContactProfileEvents } from './drovr-contact-profile-sync'
import {
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from './drovr-outbox'
import { encodeHeldContinuationEnvelope } from './drovr-outbox-control'
import { ACK_TOMBSTONE_BODY } from './contact-sync-profile-ack-schema'
import {
	ackTombstoneKey,
	ackTombstoneIdempotencyKey,
	makeAckTombstone,
} from './contact-sync-ack-tombstone'

type Row = typeof drovrOutbox.$inferSelect
function fixture(linkCount = 1) {
	const at = '2032-01-01T00:00:00.000Z',
		target = 'synthetic-admission'
	const events = buildContactProfileEvents({
		contactId: 'synthetic-admission-contact',
		profileVersion: 3,
		occurredAt: at,
		profile: { email: 'synthetic@example.test', firstName: null, holds: [] },
		offers: [],
		links: Array.from({ length: linkCount }, (_, index) => ({
			journeyId: 'value-path-skills-course',
			emailKey: `synthetic-${index}`,
			issuedAt: at,
			expiresAt: '2032-05-01T00:00:00.000Z',
			variables: {},
			sendTimeFields: [],
		})),
	})
	const base: DrovrOutboxRow[] = events.map((event) => {
		const entry = outboxEntryForEvent(event, 'bulkDelta'),
			key = drovrOutboxDedupeKey(target, entry)
		return {
			...entry,
			id: key,
			dedupeKey: key,
			target,
			status: 'pending',
			attempts: 0,
			lastStatus: null,
			lastError: null,
			firstFailedAt: at,
			nextAttemptAt: at,
			lastAttemptAt: null,
			deliveredAt: null,
			releasedAt: null,
			createdAt: at,
		}
	})
	const state = freezeProfileAckRequest({
		target,
		contactId: events[0]!.contactId,
		profileVersion: 3,
		registeredAt: at,
		rows: base,
	})
	let rows: Row[] = base.map((row) => ({
		...row,
		heldContinuation: encodeHeldContinuationEnvelope({
			v: 1,
			profileAck:
				row.dedupeKey === state.ref.coordinatorKey
					? state
					: { v: 1, role: 'member', ref: state.ref },
		}),
	}))
	const readRows = vi.fn(
		async (_db: unknown, scope: string, keys: readonly string[]) =>
			rows.filter(
				(row) => row.target === scope && keys.includes(row.dedupeKey),
			),
	)
	const args = {
		database: {},
		target,
		ref: state.ref,
		events: [events[0]!],
		readRows,
	}
	return {
		state,
		events,
		args,
		readRows,
		get rows() {
			return rows
		},
		set rows(value: Row[]) {
			rows = value
		},
	}
}
describe('frozen SDK admission, never capture or transport authority', () => {
	it('returns terminal typed expiry for absent selected evidence without reconstructing it', async () => {
		const f = fixture()
		f.rows = []
		expect(await guardProfileAckWorkerAdmission(f.args)).toMatchObject({
			_tag: 'AckEvidenceExpired',
			profileVersion: 3,
			requestId: f.state.ref.requestId,
		})
		expect(f.readRows).toHaveBeenCalledTimes(1)
	})
	it('checks whole original membership, not only the surviving profile or an old successful read', async () => {
		const f = fixture()
		await expect(
			guardProfileAckWorkerAdmission(f.args),
		).resolves.toBeUndefined()
		f.rows = f.rows.filter((row) => row.eventType !== 'contact.links.issued')
		expect(await guardProfileAckWorkerAdmission(f.args)).toMatchObject({
			_tag: 'AckEvidenceExpired',
		})
	})
	it('does not make terminal expiry discard a surviving native debt row or license its recapture', async () => {
		const f = fixture()
		f.args.events = [f.events[1]!]
		f.rows = f.rows.filter(
			(row) => row.dedupeKey !== f.state.ref.coordinatorKey,
		)
		expect(await guardProfileAckWorkerAdmission(f.args)).toMatchObject({
			_tag: 'AckEvidenceExpired',
		})
		expect(
			await guardProfileAckWorkerAdmission({ ...f.args, nativeDebt: true }),
		).toMatchObject({ _tag: 'AckEvidenceExpired' })
		// Missing profile authority never licenses a new birth; native debt remains owed.
		expect(f.rows[0]!.status).toBe('pending')
		f.rows = []
		expect(
			await guardProfileAckWorkerAdmission({ ...f.args, nativeDebt: true }),
		).toMatchObject({ _tag: 'AckEvidenceExpired' })
	})
	it('permits an unchanged retained native profile debt, but refuses a mutated first body', async () => {
		const f = fixture()
		f.rows = f.rows.slice(0, 1)
		expect(await guardProfileAckWorkerAdmission(f.args)).toMatchObject({
			_tag: 'AckEvidenceExpired',
		})
		await expect(
			guardProfileAckWorkerAdmission({ ...f.args, nativeDebt: true }),
		).resolves.toBeUndefined()
		f.rows[0]!.body = {
			...f.events[0]!,
			payload: {
				profileVersion: 3,
				email: 'mutated@example.test',
				firstName: null,
				holds: [],
			},
		}
		await expect(
			guardProfileAckWorkerAdmission({ ...f.args, nativeDebt: true }),
		).rejects.toThrow('original frozen body')
	})
	it('honors an expired tombstone fence even if matching original bodies reappear', async () => {
		const f = fixture()
		f.rows.push({
			...f.rows[0]!,
			dedupeKey: ackTombstoneKey(f.state.ref),
			idempotencyKey: ackTombstoneIdempotencyKey(f.state.ref),
			createdAt: '2032-03-01T00:00:00.000Z',
			endpoint: 'control',
			source: 'ackTombstone',
			eventType: 'profile.ack.tombstone',
			status: 'ackTombstone',
			body: ACK_TOMBSTONE_BODY,
			heldContinuation: encodeHeldContinuationEnvelope({
				v: 1,
				profileAck: makeAckTombstone(f.state.ref, {
					createdAt: '2032-03-01T00:00:00.000Z',
					reason: 'expired-evidence',
				}),
			}),
		})
		expect(await guardProfileAckWorkerAdmission(f.args)).toMatchObject({
			_tag: 'AckEvidenceExpired',
		})
	})
	it('checks an empty ACK-only SDK request rather than treating it as genuine zero-wire work', async () => {
		const f = fixture()
		f.rows = []
		f.args.events = []
		expect(
			await guardProfileAckWorkerAdmission({
				...f.args,
				ackOnly: true,
				nativeDebt: true,
			}),
		).toMatchObject({ _tag: 'AckEvidenceExpired' })
	})
	it('never consults coordination for genuine signup/purchase/unsubscribe', async () => {
		const f = fixture()
		for (const type of [
			'contact.created',
			'purchase.recorded',
			'contact.unsubscribed',
		] as const)
			await expect(
				guardProfileAckWorkerAdmission({
					...f.args,
					events: [{ ...f.events[0]!, type }],
				}),
			).resolves.toBeUndefined()
		expect(f.readRows).not.toHaveBeenCalled()
	})
	it('refuses a coordination-adapter failure instead of classifying it as expired permission', async () => {
		const f = fixture(128)
		f.readRows.mockImplementation(async (_db, scope, keys) => {
			if (keys.length === 129)
				throw {
					code: 'ER_BAD_FIELD_ERROR',
					errno: 1054,
					message: "Unknown column 'heldContinuation'",
				}
			return f.rows.filter(
				(row) => row.target === scope && keys.includes(row.dedupeKey),
			)
		})
		await expect(guardProfileAckWorkerAdmission(f.args)).rejects.toThrow()
	})
	it('refuses foreign SDK target and cross-contact events without a read', async () => {
		const f = fixture()
		for (const args of [
			{ ...f.args, target: 'another-target' },
			{
				...f.args,
				events: [{ ...f.events[0]!, contactId: 'another-contact' }],
			},
		])
			await expect(guardProfileAckWorkerAdmission(args)).rejects.toThrow(
				'ProfileAckConflict:',
			)
		expect(f.readRows).not.toHaveBeenCalled()
	})
})
