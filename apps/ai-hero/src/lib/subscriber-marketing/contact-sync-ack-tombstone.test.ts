import { Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { expect, it, vi } from 'vitest'
import {
	ACK_TOMBSTONE_BODY,
	ACK_TOMBSTONE_ENDPOINT,
	ACK_TOMBSTONE_EVENT_TYPE,
	ACK_TOMBSTONE_MAX_AGE_MS,
	ACK_TOMBSTONE_SOURCE,
	ACK_TOMBSTONE_STATUS,
	AckTombstoneBody,
	type ProfileAckReference,
} from './contact-sync-profile-ack-schema'
import {
	ackTombstoneIdempotencyKey,
	ackTombstoneKey,
	AckTombstoneControlError,
	makeAckTombstone,
	readAckTombstone,
	retainAckTombstone,
	shouldPurgeAckTombstone,
} from './contact-sync-ack-tombstone'
import {
	captureDrovrOutbox,
	drovrOutboxDedupeKey,
	type DrovrOutboxEntry,
	type DrovrOutboxRow,
} from './drovr-outbox'
import {
	fromStored,
	createDrizzleDrovrOutboxStore,
} from './drovr-outbox-drizzle'
import { encodeHeldContinuationEnvelope, readHeldContinuationEnvelope } from './drovr-outbox-control'
import { profileAckRetirementFor, stageProfileAckRetirement } from './contact-sync-profile-ack-retirement'
import {
	assertOutboxWireEntry,
	assertOutboxWireRow,
	DROVR_OUTBOX_WIRE_STATUSES,
	OutboxControlDispatchError,
} from './drovr-outbox-wire-status'
import {
	postDrovrOutboxRow,
	type DrovrOutboxPostPorts,
} from './drovr-outbox-replay-post'
import { queueCappedReplay } from './contact-sync-replay-queue'
const at = '2032-01-01T00:00:00.000Z'
function reference(version = 3, period?: string): ProfileAckReference {
	const scope = {
		target: 'synthetic-tombstone-target',
		endpoint: 'events' as const,
		tenantId: 'org-aihero' as const,
		contactId: 'synthetic-contact',
		journeyId: 'contact-directory' as const,
	}
	const idempotencyKey = `profile:${scope.contactId}:${version}${period ? `:restate:${period}` : ''}`
	return {
		...scope,
		profileVersion: version,
		coordinatorKey: drovrOutboxDedupeKey(scope.target, {
			...scope,
			idempotencyKey,
		}),
		requestId: 'd'.repeat(64),
		request: period ? { kind: 'restate', period } : { kind: 'delta' },
	}
}
function fixture() {
	const ref = reference()
	const state = makeAckTombstone(ref, {
		createdAt: at,
		reason: 'incomplete-proof',
	})
	const row: Record<string, unknown> = {
		id: 'synthetic-control-id',
		dedupeKey: ackTombstoneKey(ref),
		target: ref.target,
		endpoint: ACK_TOMBSTONE_ENDPOINT,
		tenantId: ref.tenantId,
		contactId: ref.contactId,
		journeyId: ref.journeyId,
		eventType: ACK_TOMBSTONE_EVENT_TYPE,
		idempotencyKey: ackTombstoneIdempotencyKey(ref),
		body: ACK_TOMBSTONE_BODY,
		needsFanOut: false,
		source: ACK_TOMBSTONE_SOURCE,
		status: ACK_TOMBSTONE_STATUS,
		attempts: 0,
		lastStatus: null,
		lastError: null,
		lastAttemptAt: null,
		deliveredAt: null,
		releasedAt: null,
		createdAt: at,
		occurredAt: at,
		firstFailedAt: at,
		nextAttemptAt: at,
		heldContinuation: JSON.parse(
			encodeHeldContinuationEnvelope({ v: 1, profileAck: state }),
		),
	}
	return { state, row }
}
it('retirement keeps all four independent operational controls and refuses a duplicate renewing the native negative lifetime', () => {
	const f = fixture(), ref = f.state.ref
	const scope = { key: 'b'.repeat(64), target: ref.target, endpoint: 'events', tenantId: 'org-aihero', contactId: ref.contactId, journeyId: 'synthetic-journey', eventType: 'contact.unsubscribed', idempotencyKey: 'owner:synthetic-stop', occurredAt: at }
	const other = { continuation: { v: 1, blocked: true, reason: 'synthetic hold' }, replayProof: { v: 1, handoffs: 3, waitingForStop: true }, ownerStopRejection: { v: 1, scope, rejectionCode: 'cold-start-never-born', httpStatus: 409, rejectedAttempt: { runId: 'synthetic-run', requestId: '00000000-0000-4000-8000-000000000000', stepKey: scope.key, attempt: 0 }, decidedAt: at }, unsubscribeSupersession: { v: 1, scope, source: { table: 'AI_ContactEvent', eventType: 'contact.resubscribed', contactId: ref.contactId, occurredAt: '2032-01-02T00:00:00.000Z' }, decidedAt: '2032-01-02T00:00:00.000Z' } }
	const native = { target: ref.target, dedupeKey: 'a'.repeat(64), heldContinuation: encodeHeldContinuationEnvelope({ v: 1, ...other, profileAck: { v: 1, role: 'member', ref } }) }
	const before = structuredClone(native)
	const retirement = profileAckRetirementFor(f.state, { now: Date.parse(f.state.expiresAt) })!
	const staged = stageProfileAckRetirement({ markerRow: f.row, retirement, rows: [native] })
	expect(native).toEqual(before)
	const decoded = readHeldContinuationEnvelope(staged[0]!.encoded)!
	for (const key of Object.keys(other) as (keyof typeof other)[]) expect(decoded[key]).toEqual(other[key])
	expect(decoded.profileAck).toEqual({ v: 1, role: 'member', ref, retirement })
	const installed = { ...native, heldContinuation: staged[0]!.encoded }
	expect(stageProfileAckRetirement({ markerRow: f.row, retirement, rows: [installed] })).toEqual(staged)
	const duplicate = makeAckTombstone(ref, { createdAt: '2032-01-02T00:00:00.000Z', reason: 'expired-evidence' })
	const duplicateRow = { ...f.row, createdAt: duplicate.createdAt, heldContinuation: encodeHeldContinuationEnvelope({ v: 1, profileAck: duplicate }) }
	const later = profileAckRetirementFor(duplicate, { now: Date.parse(duplicate.expiresAt) })!
	expect(() => stageProfileAckRetirement({ markerRow: duplicateRow, retirement: later, rows: [installed] })).toThrow('renew a retired native lifetime')
})
it('generated retention boundaries require positive age or version change, never missing evidence or 399-day rounding', () => {
	fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 0, max: 399 * 86400000 }), (version, elapsed) => {
		const marker = makeAckTombstone(reference(version), { createdAt: at, reason: 'incomplete-proof' })
		expect(profileAckRetirementFor(marker, { now: Date.parse(at) + elapsed })).toBeUndefined()
		expect(profileAckRetirementFor(marker, { now: Date.parse(at) + elapsed, currentVersion: version })).toBeUndefined()
		expect(profileAckRetirementFor(marker, { now: Date.parse(at) + elapsed, currentVersion: version + 1 })).toMatchObject({ createdAt: at, expiresAt: marker.expiresAt, reason: 'version-changed' })
		expect(profileAckRetirementFor(marker, { now: Date.parse(marker.expiresAt) })).toMatchObject({ createdAt: at, expiresAt: marker.expiresAt, reason: 'lifetime-expired' })
	}), { numRuns: 100 })
})
it('monotonically fences purged evidence without replacing the first cause, identity or 400-day expiry', () => {
	const first = makeAckTombstone(reference(), {
		createdAt: at,
		reason: 'ack-write-failed',
	})
	const later = makeAckTombstone(reference(), {
		createdAt: '2032-01-02T00:00:00.000Z',
		reason: 'expired-evidence',
	})
	const fenced = retainAckTombstone(first, later)
	expect(fenced).toEqual({ ...first, evidenceExpired: true })
	expect(fenced.reason).toBe('ack-write-failed')
	expect(fenced.createdAt).toBe(first.createdAt)
	expect(fenced.expiresAt).toBe(first.expiresAt)
	expect(retainAckTombstone(fenced, first)).toBe(fenced)
	const { row } = fixture()
	row.heldContinuation = JSON.parse(
		encodeHeldContinuationEnvelope({ v: 1, profileAck: fenced }),
	)
	expect(readAckTombstone(row).evidenceExpired).toBe(true)
	expect(() =>
		encodeHeldContinuationEnvelope({
			v: 1,
			profileAck: { ...fenced, evidenceExpired: false },
		}),
	).toThrow()
})
it('stores only the exact NOT NULL sentinel and independently typed failed-ACK metadata', () => {
	const { state, row } = fixture()
	expect(ACK_TOMBSTONE_BODY).toEqual({ control: 'ackTombstone', v: 1 })
	expect(Schema.decodeUnknownSync(AckTombstoneBody)(row.body)).toEqual(
		ACK_TOMBSTONE_BODY,
	)
	expect(readAckTombstone(row)).toEqual(state)
	row.body = JSON.stringify(ACK_TOMBSTONE_BODY)
	row.createdAt = '2032-01-01 00:00:00.000'
	expect(readAckTombstone(row)).toEqual(state)
	expect(JSON.stringify(state)).not.toContain('"body":')
	expect(DROVR_OUTBOX_WIRE_STATUSES).not.toContain('ackTombstone')
})
it('keys the logical request, not the attempted replacement proof, so conflicting proofs cannot mint a second row', () => {
	const ref = reference(),
		changed = { ...ref, requestId: 'e'.repeat(64) }
	expect(ackTombstoneKey(changed)).toBe(ackTombstoneKey(ref))
	const original = makeAckTombstone(ref, {
		createdAt: at,
		reason: 'ack-write-failed',
	})
	const replacement = makeAckTombstone(changed, {
		createdAt: at,
		reason: 'ack-write-failed',
	})
	expect(() => retainAckTombstone(original, replacement)).toThrow(
		/different frozen request\/proof/,
	)
	expect(ackTombstoneKey(reference(3, '2032-01'))).not.toBe(
		ackTombstoneKey(reference(3, '2032-02')),
	)
})
it('does not extend first-created expiry on repeated failed-ACK bookkeeping', () => {
	const { state } = fixture()
	const later = makeAckTombstone(state.ref, {
		createdAt: '2032-01-03T00:00:00.000Z',
		reason: 'ack-write-failed',
	})
	expect(retainAckTombstone(state, later)).toBe(state)
	expect(Date.parse(state.expiresAt) - Date.parse(state.createdAt)).toBe(
		ACK_TOMBSTONE_MAX_AGE_MS,
	)
	expect(ACK_TOMBSTONE_MAX_AGE_MS).toBe(400 * 86400000)
})
it('has an explicit version-change OR 400-day purge rule, not native seven-day retention', () => {
	const { state } = fixture(),
		end = Date.parse(state.expiresAt)
	expect(
		shouldPurgeAckTombstone(state, {
			now: Date.parse(at) + 7 * 86400000,
			currentVersion: 3,
		}),
	).toBe(false)
	expect(
		shouldPurgeAckTombstone(state, { now: end - 1, currentVersion: 3 }),
	).toBe(false)
	expect(shouldPurgeAckTombstone(state, { now: end, currentVersion: 3 })).toBe(
		true,
	)
	expect(
		shouldPurgeAckTombstone(state, { now: Date.parse(at), currentVersion: 4 }),
	).toBe(true)
	expect(shouldPurgeAckTombstone(state, { now: Date.parse(at) })).toBe(false)
	expect(() =>
		shouldPurgeAckTombstone(state, { now: NaN, currentVersion: 3 }),
	).toThrow(AckTombstoneControlError)
	expect(() =>
		shouldPurgeAckTombstone(state, { now: end, currentVersion: 0 }),
	).toThrow(AckTombstoneControlError)
})
it('property: no deletion of live same-version tombstones, including an absent current row', () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 1, max: 1000000 }),
			fc.integer({ min: 0, max: ACK_TOMBSTONE_MAX_AGE_MS - 1 }),
			fc.boolean(),
			(version, elapsed, missing) => {
				const state = makeAckTombstone(reference(version), {
					createdAt: at,
					reason: 'incomplete-proof',
				})
				expect(
					shouldPurgeAckTombstone(state, {
						now: Date.parse(at) + elapsed,
						currentVersion: missing ? undefined : version,
					}),
				).toBe(false)
			},
		),
		{ seed: 0xa1c0, numRuns: 1000 },
	)
})
it.each([
	{ status: 'delivered' },
	{ status: 'rejected' },
	{ source: 'live' },
	{ endpoint: 'events' },
	{ eventType: 'contact.profile.updated' },
	{ needsFanOut: true },
	{ deliveredAt: at },
	{ lastStatus: 202 },
	{ lastAttemptAt: at },
	{ attempts: 1 },
	{ releasedAt: at },
	{ body: { type: 'contact.profile.updated' } },
	{ body: { control: 'ackTombstone', v: 2 } },
	{ body: { control: 'ackTombstone', v: 1, email: 'synthetic@example.test' } },
	{ dedupeKey: 'f'.repeat(64) },
	{ target: 'another-target' },
	{ createdAt: '2032-01-02T00:00:00.000Z' },
])('refuses malformed/control-to-wire/history conflation %j', (change) => {
	const { row } = fixture()
	expect(() => readAckTombstone({ ...row, ...change })).toThrow(
		AckTombstoneControlError,
	)
})
it('never reads operator prose to decode a control row', () => {
	const { state, row } = fixture()
	Object.defineProperty(row, 'lastError', {
		get: () => {
			throw new Error('lastError became protocol')
		},
	})
	expect(readAckTombstone(row)).toEqual(state)
	expect(() =>
		fromStored(row as unknown as Parameters<typeof fromStored>[0]),
	).toThrow(OutboxControlDispatchError)
})
it('rejects fake native bodies/extra sentinel fields via Schema, not a prose prefix', () => {
	for (const value of [
		{},
		{ control: 'ackTombstone', v: 2 },
		{ control: 'ackTombstone', v: 1, type: 'contact.profile.updated' },
	])
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(AckTombstoneBody, {
					onExcessProperty: 'error',
				})(value),
			),
		).toBe(true)
})
it.each([
	{ status: 'ackTombstone' },
	{ source: 'ackTombstone' },
	{ endpoint: 'control' },
	{ eventType: 'profile.ack.tombstone' },
	{ body: ACK_TOMBSTONE_BODY },
	{ status: 'future-unknown' },
])(
	'each independent wire fence refuses control metadata before dispatch: %j',
	(change) => {
		const value = {
			status: 'pending',
			source: 'bulkDelta',
			endpoint: 'events',
			body: { type: 'contact.profile.updated' },
			...change,
		}
		expect(() => assertOutboxWireEntry(value)).toThrow(
			OutboxControlDispatchError,
		)
		expect(() => assertOutboxWireRow(value)).toThrow(OutboxControlDispatchError)
	},
)
it('the actual replay transport and ordinary capture refuse control rows before ANY port is read', async () => {
	const { row } = fixture()
	const touched = vi.fn(() => {
		throw new Error('control reached a wire port')
	})
	const ports = new Proxy({}, { get: touched })
	await expect(
		postDrovrOutboxRow(
			row as unknown as DrovrOutboxRow,
			ports as DrovrOutboxPostPorts,
		),
	).rejects.toThrow(OutboxControlDispatchError)
	await expect(
		captureDrovrOutbox({
			store: ports as never,
			target: String(row.target),
			entries: [row as unknown as DrovrOutboxEntry],
			now: new Date(at),
			reason: 'synthetic misuse',
			log: ports as never,
		}),
	).rejects.toThrow(OutboxControlDispatchError)
	await expect(
		queueCappedReplay(
			row as unknown as DrovrOutboxRow,
			touched,
			Date.parse(at),
			touched,
			touched,
		),
	).rejects.toThrow(OutboxControlDispatchError)
	await expect(
		createDrizzleDrovrOutboxStore(ports).insertIgnore([
			row as unknown as DrovrOutboxRow,
		]),
	).rejects.toThrow(OutboxControlDispatchError)
	expect(touched).not.toHaveBeenCalled()
	row.body = 'not even JSON'
	expect(() =>
		fromStored(row as unknown as Parameters<typeof fromStored>[0]),
	).toThrow(OutboxControlDispatchError)
})
