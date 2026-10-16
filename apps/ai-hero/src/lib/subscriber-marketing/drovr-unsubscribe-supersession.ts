import { activeContactStops } from './contact-stop-rule'
import { DROVR_OUTBOX_WIRE_STATUSES } from './drovr-outbox-wire-status'
import {
	readHeldContinuationEnvelope,
	readWithHeldContinuationFallback,
} from './drovr-outbox-control'
import {
	readUnsubscribeSupersession,
	supersededUnsubscribeAt,
	supersessionInstant,
	unsubscribeSupersessionDiagnostic,
	type UnsubscribeProofRow,
} from './drovr-unsubscribe-supersession-proof'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
export { supersededUnsubscribeAt } from './drovr-unsubscribe-supersession-proof'

/** Contract 3mxwwjnmt7iq6: arrival-ordered legacy receivers must never get
 * a historical unsubscribe after a strictly newer whole-second resubscribe. */
export function supersedingResubscribeAt(
	stop: { eventType: string; occurredAt: string },
	lift?: string,
): string | undefined {
	if (stop.eventType !== 'contact.unsubscribed' || !lift) return undefined
	return activeContactStops([
		{ kind: 'unsubscribed', at: stop.occurredAt },
		{ kind: 'resubscribed', at: lift },
	]).unsubscribed
		? undefined
		: lift
}
/** Display only. This text is not a protocol and has no parser. */
export const supersededUnsubscribeReason = unsubscribeSupersessionDiagnostic
const fail = (issue: string): never => {
	throw new Error(
		`UnsubscribeClosure: you resumed a historical unsubscribe, and it failed because its typed source proof has ${issue}. Accepted: a full-scope Schema-valid unsubscribeSupersession member with a strictly newer whole-second contact.resubscribed. Fix: retain the gate and inspect its typed evidence; never reopen it or parse lastError. Debug: inspect heldContinuation and the ContactEvent source without exposing event bodies.`,
	)
}
const isoOf = (value: string | Date): string =>
	supersessionInstant(value) ?? fail('an invalid immutable event clock')

export async function latestResubscribeLifts(
	database: unknown,
	contactIds: readonly string[],
): Promise<Map<string, string>> {
	if (!contactIds.length) return new Map()
	const [{ contactEvent }, { and, eq, inArray, max }] = await Promise.all([
		import('@/db/schema'),
		import('drizzle-orm'),
	])
	const db = database as {
		select(fields: unknown): {
			from(table: unknown): {
				where(clause: unknown): {
					groupBy(
						...columns: unknown[]
					): Promise<{ contactId: string; at: string | Date | null }[]>
				}
			}
		}
	}
	const rows = await db
		.select({
			contactId: contactEvent.contactId,
			at: max(contactEvent.occurredAt),
		})
		.from(contactEvent)
		.where(
			and(
				inArray(contactEvent.contactId, [...new Set(contactIds)]),
				eq(contactEvent.eventType, 'contact.resubscribed'),
			),
		)
		.groupBy(contactEvent.contactId)
	return new Map(
		rows
			.filter((row) => row.at !== null)
			.map((row) => [row.contactId, isoOf(row.at!)]),
	)
}
export type UnsubscribeGateRow = UnsubscribeProofRow & {
	id: string
	status: string
	heldContinuationAvailable?: boolean
}
/** A missing optional reader column yields no proof and keeps the gate. A
 * writer never falls back to prose. The transaction preserves first bodies,
 * HTTP history, all other envelope members and newer operator permissions. */
export async function closeSupersededUnsubscribeRows<
	T extends UnsubscribeGateRow,
>(
	database: unknown,
	target: string,
	rows: T[],
): Promise<
	(T & { supersededAt?: string; unsubscribeSupersessionError?: string })[]
> {
	const candidates = rows.filter(
		(row) =>
			row.eventType === 'contact.unsubscribed' &&
			row.heldContinuationAvailable !== false,
	)
	if (candidates.length) {
		const lifts = await latestResubscribeLifts(
			database,
			candidates.map((row) => row.contactId),
		)
		const { persistUnsubscribeSupersession } =
			await import('./drovr-unsubscribe-supersession-persistence')
		for (const row of candidates) {
			const lift = supersedingResubscribeAt(
				{ eventType: row.eventType, occurredAt: isoOf(row.occurredAt) },
				lifts.get(row.contactId),
			)
			if (!lift) continue
			let encoded: string | undefined
			try {
				const state = readHeldContinuationEnvelope(row.heldContinuation)
				encoded =
					row.status === 'held' ? state?.continuation?.encoded : undefined
			} catch {
				continue
			} // Invalid metadata is retained/gated, never repaired by overwriting it.
			const saved = await persistUnsubscribeSupersession(database, {
				target,
				key: row.dedupeKey,
				contactId: row.contactId,
				resubscribedAt: lift,
				...(encoded ? { expectedHeldEncoded: encoded } : {}),
			})
			Object.assign(row, saved)
		}
	}
	return rows.map((row) => {
		if (row.eventType !== 'contact.unsubscribed') return row
		const proof = readUnsubscribeSupersession(row)
		return {
			...row,
			...(proof.proved
				? { supersededAt: proof.proof.source.occurredAt }
				: row.status === 'superseded'
					? {
							unsubscribeSupersessionError: `UnsubscribeClosure: you read a closed stop, and it failed because its typed proof has ${proof.issue}. Accepted: a full-scope unsubscribeSupersession member. Fix: retain the gate and restore audited evidence. Debug: inspect heldContinuation, never lastError.`,
						}
					: {}),
		}
	})
}

async function retainedUnsubscribes(
	database: unknown,
	target: string,
	keys: readonly string[],
): Promise<UnsubscribeGateRow[]> {
	const [{ drovrOutbox }, { and, eq, inArray, getTableColumns }] =
		await Promise.all([
			import('@/db/drovr-outbox-schema'),
			import('drizzle-orm'),
		])
	const db = database as typeof import('@/db').db
	const { heldContinuation: _control, ...legacy } = getTableColumns(drovrOutbox)
	const read = (withControl: boolean) =>
		db
			.select(withControl ? getTableColumns(drovrOutbox) : legacy)
			.from(drovrOutbox)
			.where(
				and(
					eq(drovrOutbox.target, target),
					inArray(drovrOutbox.status, [...DROVR_OUTBOX_WIRE_STATUSES]),
					eq(drovrOutbox.eventType, 'contact.unsubscribed'),
					inArray(drovrOutbox.dedupeKey, [...keys]),
				),
			)
	try {
		return (await readWithHeldContinuationFallback(
			() => read(true),
			async () =>
				(await read(false)).map((row) => ({
					...row,
					heldContinuation: undefined,
					heldContinuationAvailable: false,
				})),
		)) as UnsubscribeGateRow[]
	} catch (error) {
		const { isMysqlMissingTableError } = await import('./drovr-outbox-drizzle')
		if (!isMysqlMissingTableError(error)) throw error
		return []
	}
}
/** Both actual transport paths call this, including legacy direct sends. */
export async function closeSupersededUnsubscribesLive(
	events: readonly DrovrShadowEvent[],
): Promise<Map<DrovrShadowEvent, string>> {
	const unsubscribes = events.filter(
		(event) => event.type === 'contact.unsubscribed',
	)
	if (!unsubscribes.length) return new Map()
	const [
		{ db },
		{ captureDrovrOutboxLive, drovrOutboxTargetFromEnv },
		{ outboxEntryForEvent, drovrOutboxDedupeKey },
	] = await Promise.all([
		import('@/db'),
		import('./drovr-outbox-live'),
		import('./drovr-outbox'),
	])
	const target = drovrOutboxTargetFromEnv()
	const keys = new Map(
		unsubscribes.map((event) => [
			event,
			drovrOutboxDedupeKey(target, outboxEntryForEvent(event, 'live')),
		]),
	)
	const retained = new Map(
		(await retainedUnsubscribes(db, target, [...keys.values()])).map((row) => [
			row.dedupeKey,
			row,
		]),
	)
	const answer = new Map<DrovrShadowEvent, string>()
	for (const event of unsubscribes) {
		const row = retained.get(keys.get(event)!)
		const at = row && supersededUnsubscribeAt(row)
		if (at) answer.set(event, at)
	}
	const remaining = unsubscribes.filter((event) => !answer.has(event))
	if (!remaining.length) return answer
	const lifts = await latestResubscribeLifts(
		db,
		remaining.map((event) => event.contactId),
	)
	const closed = remaining.filter((event) => {
		const row = retained.get(keys.get(event)!)
		return supersedingResubscribeAt(
			{
				eventType: event.type,
				occurredAt: row ? isoOf(row.occurredAt) : event.occurredAt,
			},
			lifts.get(event.contactId),
		)
	})
	for (const event of remaining) {
		const row = retained.get(keys.get(event)!)
		if (row?.status === 'superseded' && !closed.includes(event))
			return fail(
				readUnsubscribeSupersession(row).proved
					? 'an inconsistent closed disposition'
					: 'missing or malformed retained closure evidence',
			)
	}
	if (!closed.length) return answer
	const captured = await captureDrovrOutboxLive(
		closed.map((event) => outboxEntryForEvent(event, 'live')),
		undefined,
	)
	if (captured.status !== 'outboxed')
		return fail('unavailable durable first-body storage')
	const { persistUnsubscribeSupersession } =
		await import('./drovr-unsubscribe-supersession-persistence')
	for (const event of closed) {
		const row = retained.get(keys.get(event)!)
		const state = row
			? readHeldContinuationEnvelope(row.heldContinuation)
			: undefined
		const encoded =
			row?.status === 'held' ? state?.continuation?.encoded : undefined
		const saved = await persistUnsubscribeSupersession(db, {
			target,
			key: keys.get(event)!,
			contactId: event.contactId,
			resubscribedAt: lifts.get(event.contactId)!,
			...(encoded ? { expectedHeldEncoded: encoded } : {}),
		})
		const at = supersededUnsubscribeAt(saved)
		if (!at)
			return fail('a committed closure without a valid typed source boundary')
		answer.set(event, at)
	}
	return answer
}
