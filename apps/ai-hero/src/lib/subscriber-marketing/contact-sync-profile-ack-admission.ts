import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { and, eq, inArray } from 'drizzle-orm'
import { Either, Schema } from 'effect'
import { ackTombstoneKey, readAckTombstone } from './contact-sync-ack-tombstone'
import {
	expiredProfileAck,
	evaluateProfileAckCompletion,
	assertProfileAckRetainedMember,
	ProfileAckConflict,
} from './contact-sync-profile-ack'
import {
	ProfileAckReference,
	type AckEvidenceExpired,
} from './contact-sync-profile-ack-schema'
import {
	readHeldContinuationEnvelope,
	writeHeldContinuationGuard,
} from './drovr-outbox-control'
import { drovrOutboxDedupeKey, outboxEntryForEvent } from './drovr-outbox'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import { assertOutboxWireRow } from './drovr-outbox-wire-status'
import { fromStored } from './drovr-outbox-drizzle'

type Row = typeof drovrOutbox.$inferSelect
const decode = Schema.decodeUnknownEither(ProfileAckReference, {
	onExcessProperty: 'error',
})
const same = (a: ProfileAckReference, b: ProfileAckReference) =>
	a.target === b.target &&
	a.contactId === b.contactId &&
	a.profileVersion === b.profileVersion &&
	a.coordinatorKey === b.coordinatorKey &&
	a.requestId === b.requestId &&
	a.request.kind === b.request.kind &&
	(a.request.kind !== 'restate' ||
		(b.request.kind === 'restate' && a.request.period === b.request.period))
async function rowsLive(
	database: unknown,
	target: string,
	keys: readonly string[],
): Promise<Row[]> {
	const db = database as Pick<typeof import('@/db').db, 'select'>
	const rows: Row[] = []
	for (let offset = 0; offset < keys.length; offset += 128)
		rows.push(
			...(await db
				.select()
				.from(drovrOutbox)
				.where(
					and(
						eq(drovrOutbox.target, target),
						inArray(drovrOutbox.dedupeKey, keys.slice(offset, offset + 128)),
					),
				)),
		)
	return rows
}

/** Read-only consumer for an ALREADY frozen SDK reference. No flag/capture/
 * transport port: OFF cannot turn forgotten evidence into a new first request.
 * Invoke before own/capture and again inside the actual POST callback. A fresh
 * successful read proving absence returns a terminal VALUE, never an Error.
 * nativeDebt permits ONLY retained, matching, unfinished native rows; it is
 * not permission to reconstruct a missing row or a new ACK membership.
 */
export async function guardProfileAckWorkerAdmission(args: {
	database: unknown
	target: string
	ref: ProfileAckReference
	events: readonly DrovrShadowEvent[]
	nativeDebt?: boolean
	ackOnly?: boolean
	readRows?: typeof rowsLive
}): Promise<AckEvidenceExpired | undefined> {
	const events = args.events.filter(
		(event) =>
			event.type === 'contact.profile.updated' ||
			event.type === 'contact.links.issued',
	)
	if (!events.length && !args.ackOnly) return
	const decoded = decode(args.ref)
	if (Either.isLeft(decoded))
		throw new ProfileAckConflict('the worker admission reference is invalid')
	const ref = decoded.right
	if (
		ref.target !== args.target ||
		events.length > 1024 ||
		events.some(
			(event) =>
				event.tenantId !== ref.tenantId ||
				event.contactId !== ref.contactId ||
				event.journeyId !== ref.journeyId,
		)
	)
		throw new ProfileAckConflict(
			'the worker admission events are foreign or unbounded',
		)
	const keys = [
		...new Set(
			events.map((event) =>
				drovrOutboxDedupeKey(
					ref.target,
					outboxEntryForEvent(event, 'bulkDelta'),
				),
			),
		),
	]
	const read = (keys: readonly string[]) =>
		writeHeldContinuationGuard(() =>
			(args.readRows ?? rowsLive)(args.database, ref.target, keys),
		)
	const initialKeys = [
		...new Set([...keys, ref.coordinatorKey, ackTombstoneKey(ref)]),
	]
	const initial = await read(initialKeys)
	if (
		initial.some(
			(row) =>
				row.target !== ref.target || !initialKeys.includes(row.dedupeKey),
		) ||
		new Set(initial.map((row) => row.dedupeKey)).size !== initial.length
	)
		throw new ProfileAckConflict(
			'the admission reader returned foreign or duplicate rows',
		)
	const own = keys.map((key) => initial.find((row) => row.dedupeKey === key))
	if (own.some((row) => !row)) return expiredProfileAck(ref)
	const carrier = initial.find((row) => row.dedupeKey === ref.coordinatorKey)
	if (carrier) {
		assertOutboxWireRow(carrier)
		if (
			carrier.endpoint !== 'events' ||
			carrier.tenantId !== ref.tenantId ||
			carrier.contactId !== ref.contactId ||
			carrier.journeyId !== ref.journeyId ||
			carrier.eventType !== 'contact.profile.updated'
		)
			throw new ProfileAckConflict(
				'the retained profile authority has foreign native scope',
			)
	}
	const state = carrier
		? readHeldContinuationEnvelope(carrier.heldContinuation)?.profileAck
		: undefined
	if (state && (state.role !== 'coordinator' || !same(state.ref, ref)))
		throw new ProfileAckConflict(
			'the admission coordinator owns a different request',
		)
	for (const row of own) {
		assertOutboxWireRow(row!)
		const pointer = readHeldContinuationEnvelope(
			row!.heldContinuation,
		)?.profileAck
		if (
			!pointer &&
			state?.role === 'coordinator' &&
			state.completion &&
			state.members.some((member) => member.key === row!.dedupeKey)
		)
			continue
		if (!pointer || pointer.role === 'tombstone' || !same(pointer.ref, ref))
			throw new ProfileAckConflict(
				'the admission member lacks its original scoped reference',
			)
	}
	const markerRow = initial.find(
		(row) => row.dedupeKey === ackTombstoneKey(ref),
	)
	const marker = markerRow ? readAckTombstone(markerRow) : undefined
	if (marker && !same(marker.ref, ref))
		throw new ProfileAckConflict(
			'the admission tombstone retains a different first request',
		)
	if (
		state?.role === 'coordinator' &&
		keys.some((key) => !state.members.some((member) => member.key === key))
	)
		throw new ProfileAckConflict(
			'the SDK event was not in the original frozen membership',
		)
	if (state?.role === 'coordinator')
		for (const row of own)
			assertProfileAckRetainedMember(state, fromStored(row!))
	// This only leaves actual native debt for its existing handler/gates.
	// It does NOT authorize ACK or supply missing profile/birth authority.
	if (
		args.nativeDebt &&
		(!events.some((event) => event.type === 'contact.links.issued') ||
			carrier?.status === 'delivered') &&
		own.length > 0 &&
		own.every(
			(row) =>
				row!.status === 'pending' ||
				row!.status === 'deferred' ||
				row!.status === 'held' ||
				row!.status === 'rejected',
		)
	)
		return
	if (
		!state ||
		state.role !== 'coordinator' ||
		marker?.evidenceExpired ||
		marker?.reason === 'expired-evidence'
	)
		return expiredProfileAck(ref)
	const whole = await read(state.members.map((member) => member.key))
	if (
		whole.length !== state.members.length ||
		new Set(whole.map((row) => row.dedupeKey)).size !== whole.length ||
		whole.some(
			(row) =>
				row.target !== ref.target ||
				!state.members.some((member) => member.key === row.dedupeKey),
		)
	)
		return expiredProfileAck(ref)
	const evaluation = evaluateProfileAckCompletion(state, whole.map(fromStored))
	return evaluation._tag === 'AckEvidenceExpired' ? evaluation : undefined
}

export async function guardProfileAckWorkerAdmissionLive(
	ref: ProfileAckReference,
	events: readonly DrovrShadowEvent[],
	nativeDebt = false,
	ackOnly = false,
): Promise<AckEvidenceExpired | undefined> {
	const [{ db }, { drovrOutboxTargetFromEnv }] = await Promise.all([
		import('@/db'),
		import('./drovr-outbox-live'),
	])
	const result = await guardProfileAckWorkerAdmission({
		database: db,
		target: drovrOutboxTargetFromEnv(),
		ref,
		events,
		nativeDebt,
		ackOnly,
	})
	if (result) {
		try {
			const [{ log }, { logAckEvidenceExpiredOncePerProcess }] =
				await Promise.all([
					import('@/server/logger'),
					import('./contact-sync-profile-ack-expired-log'),
				])
			await logAckEvidenceExpiredOncePerProcess(result, log)
		} catch {
			/* Terminal expiry remains terminal without a logger. */
		}
	}
	return result
}
