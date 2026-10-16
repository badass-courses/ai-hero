import { BULK_OUTBOX_QUEUE_WAIT_MS } from './contact-sync-bulk'
import { DROVR_OUTBOX_WIRE_STATUSES } from './drovr-outbox-wire-status'
import {
	birthGates,
	drovrOutboxDedupeKey,
	isDrovrOutboxStatus,
	isOutboxBirth,
	isOutboxStop,
	openStopBefore,
	outboxEntryForEvent,
	type DrovrOutboxOpenGate,
	type DrovrOutboxSource,
	type DrovrOutboxStatus,
	type DrovrOutboxWorkState,
} from './drovr-outbox'
import {
	captureDrovrOutboxLive,
	drovrOutboxTargetFromEnv,
	drovrOutboxWorkStatesLive,
	openDrovrOutboxGatesLive,
} from './drovr-outbox-live'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import type { DrovrBatchOutcome } from './drovr-shadow-delivery'
export { retryEventIdentity } from './contact-sync-retry-route'
export type OwnedRetryEvent = {
	event: DrovrShadowEvent
	clampAt: number
	delivered: boolean
	status: DrovrOutboxStatus
	outboxKey: string
}

/** One immutable identity per POST. Fresh status is authoritative; a retained
 * held/rejected row never becomes permission just because this SDK run is old. */
export function retainedRetryOutcome(
	record: OwnedRetryEvent,
	states: readonly DrovrOutboxWorkState[],
): DrovrBatchOutcome | undefined {
	const fail = () =>
		new Error(
			'RetryDisposition: you resumed owned delivery, and it failed because its fresh scoped disposition is missing or invalid. Accepted: one retained state for the full target/endpoint/tenant/contact/journey/key identity. Fix: keep the work held and restore its state before explicit release. Debug: compare the scoped outbox key, not the bare wire key.',
		)
	const state = states.length === 1 ? states[0] : undefined
	if (!state || state.key !== record.outboxKey) throw fail()
	if (state.heldBatchBlocked)
		return { accepted: 0, rejected: 0, retainedHeld: 1 }
	switch (state.status) {
		case 'pending':
		case 'deferred':
			return undefined
		case 'delivered':
			return { accepted: 0, rejected: 0, alreadyDelivered: true }
		case 'held':
			return { accepted: 0, rejected: 0, retainedHeld: 1 }
		case 'rejected':
			return { accepted: 0, rejected: 0, retainedRejected: 1 }
		case 'superseded':
			if (record.event.type !== 'contact.unsubscribed') throw fail()
			return { accepted: 0, rejected: 0, supersededUnsubscribes: 1 }
		default: {
			const exhaustive: never = state.status
			throw fail()
		}
	}
}
export function retryHeldByGates(
	record: OwnedRetryEvent,
	gates: readonly DrovrOutboxOpenGate[],
): boolean {
	const entry = outboxEntryForEvent(record.event, 'contactSync')
	return gates.some(
		(gate) =>
			gate.contactId === entry.contactId &&
			((isOutboxBirth(gate) && birthGates(gate, entry)) ||
				(isOutboxStop(gate) && openStopBefore(entry, [gate]) !== undefined)),
	)
}

/** Read once for disposition, not delivered-only plus another status query.
 * Capped callers recheck owed stops/births too. Genuine live offers retain
 * their existing unpaced path and do not acquire a new family-birth gate. */
export async function readRetryDispositionLive(
	record: OwnedRetryEvent,
	options: { gates?: boolean } = {},
): Promise<DrovrBatchOutcome | undefined> {
	const entries = [outboxEntryForEvent(record.event, 'contactSync')]
	const retained = retainedRetryOutcome(
		record,
		await drovrOutboxWorkStatesLive(entries),
	)
	if (retained) return retained
	if (
		options.gates !== false &&
		retryHeldByGates(
			record,
			await openDrovrOutboxGatesLive([record.event.contactId]),
		)
	)
		return { accepted: 0, rejected: 0, retainedHeld: 1 }
	return undefined
}

/** Freeze legacy retry inputs and newly derived directory births before a
 * booking. On a healthy capacity handoff the new run reads the FIRST stored
 * bytes/clock, not a new lifecycle snapshot or a new birth clamp instant.
 */
export async function ownRetryEvents(
	events: readonly DrovrShadowEvent[],
	source: DrovrOutboxSource,
	clampAt: number,
): Promise<OwnedRetryEvent[]> {
	if (!events.length) return []
	const fail = (why: string) =>
		new Error(
			`RetryOwnership: you prepared durable retry work, and it failed because ${why}. Accepted: every immutable event with its original send clock retained before POST. Fix: restore the outbox and retry unchanged. Debug: inspect the target, dedupe key and capture receipt.`,
		)
	const entries = events.map((event) =>
		outboxEntryForEvent(event, source, { sentAt: clampAt }),
	)
	const captured = await captureDrovrOutboxLive(entries, undefined, {
		nextAttemptAt: new Date(Date.now() + BULK_OUTBOX_QUEUE_WAIT_MS),
	})
	if (captured.status !== 'outboxed')
		throw fail('durable capture is unavailable')
	const [{ db }, { drovrOutbox }, { and, eq, inArray }] = await Promise.all([
		import('@/db'),
		import('@/db/drovr-outbox-schema'),
		import('drizzle-orm'),
	])
	const target = drovrOutboxTargetFromEnv()
	const keys = entries.map((entry) => drovrOutboxDedupeKey(target, entry))
	const rows = await db
		.select({
			key: drovrOutbox.dedupeKey,
			body: drovrOutbox.body,
			firstFailedAt: drovrOutbox.firstFailedAt,
			status: drovrOutbox.status,
		})
		.from(drovrOutbox)
		.where(
			and(
				eq(drovrOutbox.target, target),
				inArray(drovrOutbox.status, [...DROVR_OUTBOX_WIRE_STATUSES]),
				inArray(drovrOutbox.dedupeKey, keys),
			),
		)
	const stored = new Map(rows.map((row) => [row.key, row]))
	return entries.map((entry, index) => {
		const row = stored.get(keys[index]!)
		if (!row) throw fail('a captured key is absent')
		let body: DrovrShadowEvent
		try {
			body = (
				typeof row.body === 'string' ? JSON.parse(row.body) : row.body
			) as DrovrShadowEvent
		} catch {
			throw fail('the retained body is not JSON')
		}
		if (
			!body ||
			body.tenantId !== entry.tenantId ||
			body.contactId !== entry.contactId ||
			body.journeyId !== entry.journeyId ||
			body.idempotencyKey !== entry.idempotencyKey ||
			body.type !== entry.eventType
		)
			throw fail('the retained body does not match its immutable scope')
		const at: unknown = row.firstFailedAt
		const raw = at instanceof Date ? at.toISOString() : String(at)
		const stamp = Date.parse(
			/(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`,
		)
		if (!Number.isFinite(stamp))
			throw fail('the original send clock is invalid')
		if (!isDrovrOutboxStatus(row.status))
			throw fail('the retained disposition is invalid')
		return {
			event: body,
			clampAt: stamp,
			delivered: row.status === 'delivered',
			status: row.status,
			outboxKey: keys[index]!,
		}
	})
}
