import { contactProfileVersion } from '@/db/contact-sync-schema'
import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { Either, Schema } from 'effect'
import { ackTombstoneKey, readAckTombstone } from './contact-sync-ack-tombstone'
import { profileAckFlagEnabled } from './contact-sync-profile-ack-flag'
import { retryHeldBatchTransaction } from './contact-sync-held-batch-transaction'
import {
	evaluateProfileAckCompletion,
	expiredProfileAck,
	ProfileAckConflict,
	profileAckConfirmationClock,
	type ProfileAckEvaluation,
} from './contact-sync-profile-ack'
import {
	PROFILE_ACK_MAX_REFERENCES,
	ProfileAckReference,
} from './contact-sync-profile-ack-schema'
import {
	encodeHeldContinuationEnvelope,
	readHeldContinuationEnvelope,
	writeHeldContinuationGuard,
} from './drovr-outbox-control'

type Database = typeof import('@/db').db
type Transaction = Pick<Database, 'select' | 'update' | 'delete'>
type NativeRow = typeof drovrOutbox.$inferSelect
const CHUNK = 128
const decodeReference = Schema.decodeUnknownEither(ProfileAckReference, {
	onExcessProperty: 'error',
})
const referenceIdentity = (ref: ProfileAckReference) =>
	JSON.stringify([
		ref.target,
		ref.contactId,
		ref.profileVersion,
		ref.coordinatorKey,
		ref.requestId,
		ref.request.kind,
		ref.request.kind === 'restate' ? ref.request.period : null,
	])

/** Only typed native keys enter this query. Every chunk requires the control
 * column, including chunks read AFTER settlement. No ordinary-reader fallback.
 */
async function lockedRows(
	tx: Transaction,
	target: string,
	keys: readonly string[],
): Promise<NativeRow[]> {
	const sorted = [...new Set(keys)].sort()
	const rows: NativeRow[] = []
	for (let offset = 0; offset < sorted.length; offset += CHUNK) {
		rows.push(
			...(await tx
				.select()
				.from(drovrOutbox)
				.where(
					and(
						eq(drovrOutbox.target, target),
						inArray(
							drovrOutbox.dedupeKey,
							sorted.slice(offset, offset + CHUNK),
						),
					),
				)
				.orderBy(asc(drovrOutbox.dedupeKey))
				.for('update')),
		)
	}
	return rows
}
function iso(value: string | Date | null): string | null {
	if (value == null) return null
	if (value instanceof Date) return value.toISOString()
	return new Date(
		/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(' ', 'T')}Z`,
	).toISOString()
}

export type ProfileAckSettlement =
	| { _tag: 'ProfileAckDisabled' }
	| {
			_tag: 'ProfileAckSettled'
			settled: number
			evaluation: ProfileAckEvaluation
			disposition?: 'acknowledged' | 'version-superseded'
	  }

/** Internal DB composition boundary, never an HTTP or broker callback.
 * Lock order is contact-version authority, coordinator, then sorted members.
 * Capture/registration and purge must use that SAME contact-first order.
 * A failed ACK write rolls the native settlement and first proof back together.
 * OFF invokes neither the callback nor any SQL; its caller uses legacy settle.
 * Native workers compose through this boundary. Producer registration and the
 * remaining lifecycle proofs are still required; this is not an enable recommendation.
 */
export async function settleAndCompleteProfileAck(args: {
	database: unknown
	ref: ProfileAckReference
	settledKeys: readonly string[]
	/** Apply ONLY the already-accepted native rows named by settledKeys. */
	settle: (transaction: unknown) => Promise<number>
	enabled?: () => Promise<boolean>
}): Promise<ProfileAckSettlement> {
	const enabled = () =>
		profileAckFlagEnabled({ readFlag: args.enabled ?? (async () => false) })
	if (!(await enabled())) return { _tag: 'ProfileAckDisabled' }
	const decoded = decodeReference(args.ref)
	if (Either.isLeft(decoded))
		throw new ProfileAckConflict(
			'the SDK reference is not a typed frozen request',
		)
	const ref = decoded.right
	const keys = [...new Set(args.settledKeys)].sort()
	if (
		!keys.length ||
		keys.length !== args.settledKeys.length ||
		keys.length > PROFILE_ACK_MAX_REFERENCES ||
		keys.some((key) => !/^[a-f0-9]{64}$/.test(key))
	)
		throw new ProfileAckConflict(
			'the settlement keys are empty, duplicated or unbounded',
		)
	const db = args.database as Pick<Database, 'transaction'>
	if (typeof db?.transaction !== 'function')
		throw new ProfileAckConflict(
			'the settlement adapter cannot provide a transaction',
		)
	return writeHeldContinuationGuard(() =>
		retryHeldBatchTransaction(async () => {
			// Never cache ON across a rolled-back attempt or a failed flag read.
			if (!(await enabled())) return { _tag: 'ProfileAckDisabled' as const }
			return db.transaction(async (tx) => {
				const [version] = await tx
					.select()
					.from(contactProfileVersion)
					.where(eq(contactProfileVersion.contactId, ref.contactId))
					.limit(1)
					.for('update')
				const roots = await lockedRows(tx, ref.target, [
					ref.coordinatorKey,
					ackTombstoneKey(ref),
				])
				const carrier = roots.find(
					(row) => row.dedupeKey === ref.coordinatorKey,
				)
				const tombstone = roots.find(
					(row) => row.dedupeKey === ackTombstoneKey(ref),
				)
				const savedTombstone = tombstone
					? readAckTombstone(tombstone)
					: undefined
				if (savedTombstone) {
					const saved = savedTombstone
					if (referenceIdentity(saved.ref) !== referenceIdentity(ref))
						throw new ProfileAckConflict(
							'the logical request retains a different first tombstone identity',
						)
				}
				const envelope = carrier
					? readHeldContinuationEnvelope(carrier.heldContinuation)
					: undefined
				const state = envelope?.profileAck
				if (
					state &&
					(state.role !== 'coordinator' ||
						referenceIdentity(state.ref) !== referenceIdentity(ref))
				)
					throw new ProfileAckConflict(
						'the retained coordinator does not own this SDK reference',
					)
				if (
					state &&
					keys.some(
						(key) => !state.members.some((member) => member.key === key),
					)
				)
					throw new ProfileAckConflict(
						'a foreign native key attempted this request settlement',
					)
				const own = await lockedRows(tx, ref.target, keys)
				const inputExpired = own.length !== keys.length
				if (own.length === 0)
					return {
						_tag: 'ProfileAckSettled' as const,
						settled: 0,
						evaluation: expiredProfileAck(ref),
					}
				for (const row of own) {
					const member = readHeldContinuationEnvelope(
						row.heldContinuation,
					)?.profileAck
					if (!member && state?.completion) continue
					if (
						!member ||
						member.role === 'tombstone' ||
						referenceIdentity(member.ref) !== referenceIdentity(ref)
					)
						throw new ProfileAckConflict(
							'a native settlement lacks its original scoped member reference',
						)
				}
				if (state)
					await lockedRows(
						tx,
						ref.target,
						state.members.map((member) => member.key),
					)
				const settled = await args.settle(tx)
				if (
					!state ||
					inputExpired ||
					savedTombstone?.reason === 'expired-evidence' ||
					savedTombstone?.evidenceExpired
				)
					return {
						_tag: 'ProfileAckSettled' as const,
						settled,
						evaluation: expiredProfileAck(ref),
					}
				// Actual post-write evidence inside this TX/effect, not pre-POST rows
				// and not an SDK-memoized positive result from a failed ACK write.
				const fresh = await lockedRows(
					tx,
					ref.target,
					state.members.map((member) => member.key),
				)
				const { fromStored } = await import('./drovr-outbox-drizzle')
				const evaluation = evaluateProfileAckCompletion(
					state,
					fresh.map(fromStored),
				)
				if (
					evaluation._tag !== 'ProfileAckReady' ||
					evaluation.alreadyCompleted
				)
					return { _tag: 'ProfileAckSettled' as const, settled, evaluation }
				let disposition: 'acknowledged' | 'version-superseded' =
					'version-superseded'
				if (version && Number(version.profileVersion) === ref.profileVersion) {
					const clock = profileAckConfirmationClock(
						evaluation.proof,
						iso(version.acknowledgedAt),
					)
					await tx
						.update(contactProfileVersion)
						.set({
							acknowledgedVersion: ref.profileVersion,
							acknowledgedAt: clock.slice(0, 23).replace('T', ' '),
							updatedAt: sql`${contactProfileVersion.updatedAt}`,
						})
						.where(
							and(
								eq(contactProfileVersion.contactId, ref.contactId),
								eq(contactProfileVersion.profileVersion, ref.profileVersion),
							),
						)
					disposition = 'acknowledged'
				}
				const encoded = encodeHeldContinuationEnvelope({
					...envelope,
					profileAck: {
						...state,
						completion: { ...evaluation.proof, disposition },
					},
				})
				await tx
					.update(drovrOutbox)
					.set({
						heldContinuation: sql`JSON_EXTRACT(${encoded}, '$')`,
					})
					.where(
						and(
							eq(drovrOutbox.target, ref.target),
							eq(drovrOutbox.dedupeKey, ref.coordinatorKey),
						),
					)
				// Completion ends member pointers, NOT native debt or receipt
				// retention. The original whole membership/first proof stays on
				// its coordinator; late SDKs carry their frozen ref independently.
				const memberKeys = state.members
					.map((member) => member.key)
					.filter((key) => key !== ref.coordinatorKey)
				for (let offset = 0; offset < memberKeys.length; offset += CHUNK)
					await tx
						.update(drovrOutbox)
						.set({
							heldContinuation: sql`JSON_REMOVE(${drovrOutbox.heldContinuation}, '$.profileAck')`,
						})
						.where(
							and(
								eq(drovrOutbox.target, ref.target),
								inArray(
									drovrOutbox.dedupeKey,
									memberKeys.slice(offset, offset + CHUNK),
								),
							),
						)
				// The ONLY non-expiry deletion: exact original failure marker is
				// replaced by a complete committed native proof, in this same TX.
				if (tombstone)
					await tx.delete(drovrOutbox).where(eq(drovrOutbox.id, tombstone.id))
				return {
					_tag: 'ProfileAckSettled' as const,
					settled,
					evaluation,
					disposition,
				}
			})
		}),
	)
}
