import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { and, eq, inArray, or } from 'drizzle-orm'
import { ProfileAckConflict } from './contact-sync-profile-ack'
import { profileAckFlagEnabled } from './contact-sync-profile-ack-flag'
import {
	settleAndCompleteProfileAck,
	type ProfileAckSettlement,
} from './contact-sync-profile-ack-persistence'
import {
	PROFILE_ACK_MAX_REFERENCES,
	type ProfileAckReference,
} from './contact-sync-profile-ack-schema'
import {
	readHeldContinuationEnvelope,
	readWithHeldContinuationFallback,
	writeHeldContinuationGuard,
} from './drovr-outbox-control'

export type ProfileAckWorkerRow = Pick<
	typeof drovrOutbox.$inferSelect,
	| 'target'
	| 'dedupeKey'
	| 'endpoint'
	| 'tenantId'
	| 'contactId'
	| 'journeyId'
	| 'eventType'
>
export type ProfileAckWorkerKey = Pick<
	ProfileAckWorkerRow,
	'target' | 'dedupeKey'
>
type MetadataRow = ProfileAckWorkerKey & { heldContinuation: unknown }
const identity = (row: ProfileAckWorkerKey) =>
	JSON.stringify([row.target, row.dedupeKey])
const eligible = (row: ProfileAckWorkerRow) =>
	row.eventType === 'contact.profile.updated' ||
	row.eventType === 'contact.links.issued'

async function readMetadata(
	database: unknown,
	rows: readonly ProfileAckWorkerRow[],
): Promise<MetadataRow[]> {
	const db = database as Pick<typeof import('@/db').db, 'select'>
	const found: MetadataRow[] = []
	for (let offset = 0; offset < rows.length; offset += 128) {
		const chunk = rows.slice(offset, offset + 128)
		found.push(
			...(await db
				.select({
					target: drovrOutbox.target,
					dedupeKey: drovrOutbox.dedupeKey,
					heldContinuation: drovrOutbox.heldContinuation,
				})
				.from(drovrOutbox)
				.where(
					or(
						...chunk.map((row) =>
							and(
								eq(drovrOutbox.target, row.target),
								eq(drovrOutbox.dedupeKey, row.dedupeKey),
								inArray(drovrOutbox.eventType, [
									'contact.profile.updated',
									'contact.links.issued',
								]),
							),
						),
					),
				)),
		)
	}
	return found
}

/** Composition inside a positive native-settlement SDK effect. The pre-read
 * only routes immutable references: NEVER use it as delivered proof. Each
 * completion rereads locked whole membership after native settlement in its
 * own transaction. No transport, broker, capture or clock refresh port exists.
 * Genuine signup/purchase/unsubscribe do not consult the feature flag.
 */
export async function settleProfileAckWorkerRows(args: {
	database: unknown
	rows: readonly ProfileAckWorkerRow[]
	enabled: () => Promise<boolean>
	/** Actual all-positive receiver answer, never inferred from note/counters. */
	receiverAccepted: boolean
	/** Undefined keys means the original legacy native update. Scoped keys
	 * restrict a grouped callback, and coordinated=true preserves later holds.
	 */
	settle: (
		database: unknown,
		keys?: readonly ProfileAckWorkerKey[],
		coordinated?: boolean,
	) => Promise<number>
	/** Test ports; live workers always use the strict SQL reader/completer. */
	readMetadata?: typeof readMetadata
	complete?: typeof settleAndCompleteProfileAck
}): Promise<{ settled: number; acknowledgements: ProfileAckSettlement[] }> {
	const candidates = args.rows.filter(eligible)
	const legacy = async () => ({
		settled: await args.settle(args.database),
		acknowledgements: [] as ProfileAckSettlement[],
	})
	if (!candidates.length) return legacy()
	if (candidates.length > PROFILE_ACK_MAX_REFERENCES)
		throw new ProfileAckConflict('the worker settlement scope is unbounded')
	const read = () =>
		(args.readMetadata ?? readMetadata)(args.database, candidates)
	const metadata = await readWithHeldContinuationFallback(read, async () => {
		// Ordinary never-enabled readers tolerate the old schema; ON cannot
		// turn a missing coordination column into an empty original scope.
		if (await profileAckFlagEnabled({ readFlag: args.enabled }))
			return writeHeldContinuationGuard(read)
		return []
	})
	const byKey = new Map(candidates.map((row) => [identity(row), row]))
	const groups = new Map<
		string,
		{ ref: ProfileAckReference; keys: ProfileAckWorkerKey[] }
	>()
	const owned = new Set<string>()
	const seen = new Set<string>()
	for (const row of metadata) {
		const candidate = byKey.get(identity(row))
		if (!candidate || seen.has(identity(row)))
			throw new ProfileAckConflict(
				'the worker metadata lookup returned a foreign or duplicate row',
			)
		seen.add(identity(row))
		const state = readHeldContinuationEnvelope(row.heldContinuation)?.profileAck
		if (!state) continue
		if (
			state.role === 'tombstone' ||
			state.ref.target !== candidate.target ||
			state.ref.endpoint !== candidate.endpoint ||
			state.ref.tenantId !== candidate.tenantId ||
			state.ref.contactId !== candidate.contactId ||
			state.ref.journeyId !== candidate.journeyId
		)
			throw new ProfileAckConflict(
				'the worker row does not own its frozen ACK scope',
			)
		owned.add(identity(row))
		const key = JSON.stringify(state.ref)
		const group = groups.get(key) ?? { ref: state.ref, keys: [] }
		group.keys.push({ target: row.target, dedupeKey: row.dedupeKey })
		groups.set(key, group)
	}
	if (!groups.size) return legacy()
	let settled = 0
	const acknowledgements: ProfileAckSettlement[] = []
	for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
		// Legacy final-refusal settlement is NOT a delivered receipt. Known
		// frozen debt remains owed, even if the flag turned OFF after capture.
		if (!args.receiverAccepted) continue
		const result = await (args.complete ?? settleAndCompleteProfileAck)({
			database: args.database,
			ref: group.ref,
			settledKeys: group.keys.map((row) => row.dedupeKey),
			enabled: args.enabled,
			settle: (tx) => args.settle(tx, group.keys, true),
		})
		acknowledgements.push(result)
		settled +=
			result._tag === 'ProfileAckDisabled'
				? await args.settle(args.database, group.keys, true)
				: result.settled
	}
	const remainder = args.rows.filter((row) => !owned.has(identity(row)))
	if (remainder.length) settled += await args.settle(args.database, remainder)
	return { settled, acknowledgements }
}
