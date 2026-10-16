import { ackTombstoneKey, readAckTombstone } from './contact-sync-ack-tombstone'
import {
	evaluateProfileAckCompletion,
	expiredProfileAck,
	profileAckConfirmationClock,
	ProfileAckConflict,
} from './contact-sync-profile-ack'
import { profileAckFlagEnabled } from './contact-sync-profile-ack-flag'
import type { ProfileAckSettlement } from './contact-sync-profile-ack-persistence'
import type { ProfileAckReference } from './contact-sync-profile-ack-schema'
import {
	encodeHeldContinuationEnvelope,
	readHeldContinuationEnvelope,
} from './drovr-outbox-control'
import type { DrovrOutboxRow } from './drovr-outbox'

type Authority = {
	profileVersion: number
	acknowledgedVersion?: number
	acknowledgedAt?: string
}
export type MemoryProfileAckCompletion = (input: {
	ref: ProfileAckReference
	/** Actual retained model rows, never a boolean/counter/cached proof. */
	readRows: (keys: readonly string[]) => Promise<readonly DrovrOutboxRow[]>
}) => Promise<ProfileAckSettlement>
const identity = (ref: ProfileAckReference) =>
	JSON.stringify([
		ref.target,
		ref.contactId,
		ref.profileVersion,
		ref.coordinatorKey,
		ref.requestId,
		ref.request.kind,
		ref.request.kind === 'restate' ? ref.request.period : null,
	])

/** Single-process model of the same frozen-clock commit, not an alternative
 * live adapter. Read and prove inside the actual caller's ACK effect. Stage
 * every bounded control encoding before mutating the owned model rows. */
export async function completeMemoryProfileAck(
	args: Parameters<MemoryProfileAckCompletion>[0] & {
		enabled: () => Promise<boolean>
		authority: () => Authority | undefined
		beforeCommit?: () => void
	},
): Promise<ProfileAckSettlement> {
	if (!(await profileAckFlagEnabled({ readFlag: args.enabled })))
		return { _tag: 'ProfileAckDisabled' }
	const ref = args.ref
	const result = (
		evaluation: Extract<
			ProfileAckSettlement,
			{ _tag: 'ProfileAckSettled' }
		>['evaluation'],
	): ProfileAckSettlement => ({
		_tag: 'ProfileAckSettled',
		settled: 0,
		evaluation,
	})
	const roots = await args.readRows([ref.coordinatorKey, ackTombstoneKey(ref)])
	const first = roots.find((row) => row.dedupeKey === ref.coordinatorKey)
	const markerRow = roots.find((row) => row.dedupeKey === ackTombstoneKey(ref))
	const marker = markerRow ? readAckTombstone(markerRow) : undefined
	if (marker && identity(marker.ref) !== identity(ref))
		throw new ProfileAckConflict(
			'the memory control retains a different first request',
		)
	if (
		!first ||
		marker?.evidenceExpired ||
		marker?.reason === 'expired-evidence'
	)
		return result(expiredProfileAck(ref))
	const initial = readHeldContinuationEnvelope(
		first.heldContinuation,
	)?.profileAck
	if (!initial || initial.role !== 'coordinator')
		return result(expiredProfileAck(ref))
	if (identity(initial.ref) !== identity(ref))
		throw new ProfileAckConflict(
			'the memory coordinator retains a different first request',
		)
	const rows = await args.readRows(initial.members.map((member) => member.key))
	const carrier = rows.find((row) => row.dedupeKey === ref.coordinatorKey)
	const envelope = carrier
		? readHeldContinuationEnvelope(carrier.heldContinuation)
		: undefined
	const state = envelope?.profileAck
	if (!carrier || !state || state.role !== 'coordinator')
		return result(expiredProfileAck(ref))
	if (identity(state.ref) !== identity(ref))
		throw new ProfileAckConflict(
			'the memory coordinator changed during the fresh whole-membership read',
		)
	for (const row of rows) {
		const pointer = readHeldContinuationEnvelope(row.heldContinuation)?.profileAck
		if (!pointer && state.completion && row.dedupeKey !== ref.coordinatorKey) continue
		if (!pointer) return result(expiredProfileAck(ref))
		if (pointer.role === 'tombstone' || identity(pointer.ref) !== identity(ref)) throw new ProfileAckConflict('the memory whole-membership proof retained a foreign original member reference')
	}
	const evaluation = evaluateProfileAckCompletion(state, rows)
	if (evaluation._tag !== 'ProfileAckReady') return result(evaluation)
	const confirmedLinks = state.members.filter(
		(member) => member.eventType === 'contact.links.issued',
	).length
	if (evaluation.alreadyCompleted)
		return {
			_tag: 'ProfileAckSettled',
			settled: 0,
			evaluation,
			confirmedLinks,
			disposition: state.completion!.disposition,
		}
	const authority = args.authority()
	const disposition =
		authority?.profileVersion === ref.profileVersion
			? ('acknowledged' as const)
			: ('version-superseded' as const)
	const clock =
		disposition === 'acknowledged'
			? profileAckConfirmationClock(evaluation.proof, authority?.acknowledgedAt)
			: undefined
	const changes = rows.map((row) => {
		const before = row.heldContinuation
		const control = readHeldContinuationEnvelope(before)
		if (row.dedupeKey === ref.coordinatorKey)
			return {
				row,
				before,
				after: encodeHeldContinuationEnvelope({
					...envelope,
					profileAck: {
						...state,
						completion: { ...evaluation.proof, disposition },
					},
				}),
			}
		if (
			!control?.profileAck ||
			identity(control.profileAck.ref) !== identity(ref)
		)
			throw new ProfileAckConflict(
				'the memory completion member lacks its original reference',
			)
		const { profileAck: _profileAck, ...remaining } = control
		return { row, before, after: encodeHeldContinuationEnvelope(remaining) }
	})
	args.beforeCommit?.()
	const previous = authority
		? {
				acknowledgedVersion: authority.acknowledgedVersion,
				acknowledgedAt: authority.acknowledgedAt,
			}
		: undefined
	try {
		for (const change of changes) change.row.heldContinuation = change.after
		if (authority && disposition === 'acknowledged') {
			authority.acknowledgedVersion = ref.profileVersion
			authority.acknowledgedAt = clock
		}
	} catch (error) {
		for (const change of changes)
			if (change.row.heldContinuation !== change.before)
				change.row.heldContinuation = change.before
		if (authority && previous) {
			authority.acknowledgedVersion = previous.acknowledgedVersion
			authority.acknowledgedAt = previous.acknowledgedAt
		}
		throw error
	}
	return {
		_tag: 'ProfileAckSettled',
		settled: 0,
		evaluation,
		confirmedLinks,
		disposition,
	}
}
