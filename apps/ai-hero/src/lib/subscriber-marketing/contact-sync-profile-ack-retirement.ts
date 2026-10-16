import {
	readAckTombstone,
	shouldPurgeAckTombstone,
} from './contact-sync-ack-tombstone'
import { ProfileAckConflict } from './contact-sync-profile-ack'
import type {
	ProfileAck,
	ProfileAckReference,
	ProfileAckRetirement,
	ProfileAckTombstone,
} from './contact-sync-profile-ack-schema'
import {
	encodeHeldContinuationEnvelope,
	readHeldContinuationEnvelope,
} from './drovr-outbox-control'

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
export function profileAckRetirementFor(
	marker: ProfileAckTombstone,
	input: { now: number; currentVersion?: number },
): ProfileAckRetirement | undefined {
	if (!shouldPurgeAckTombstone(marker, input)) return
	return {
		v: 1,
		createdAt: marker.createdAt,
		expiresAt: marker.expiresAt,
		reason:
			input.currentVersion != null &&
			input.currentVersion !== marker.ref.profileVersion
				? 'version-changed'
				: 'lifetime-expired',
	}
}
/** Pure staging only. Validate the actual dedicated row, preserve every other
 * control, and retain the first negative lifetime forever on surviving debt.
 * Callers install ALL staged member fences before deleting the marker in the
 * same transaction. No body/clock/status/prose or positive proof changes. */
export function stageProfileAckRetirement(args: {
	markerRow: Record<string, unknown>
	retirement: ProfileAckRetirement
	rows: readonly {
		target: string
		dedupeKey: string
		heldContinuation: unknown
	}[]
}): { target: string; dedupeKey: string; encoded: string }[] {
	const marker = readAckTombstone(args.markerRow)
	if (
		args.retirement.createdAt !== marker.createdAt ||
		args.retirement.expiresAt !== marker.expiresAt
	)
		throw new ProfileAckConflict(
			'marker retirement attempted to renew or replace the original negative lifetime',
		)
	if (
		args.rows.length > 1024 ||
		new Set(args.rows.map((row) => `${row.target}:${row.dedupeKey}`)).size !==
			args.rows.length
	)
		throw new ProfileAckConflict(
			'the marker retirement native scope is duplicated or exceeds its bounded original membership',
		)
	return args.rows.map((row) => {
		const envelope = readHeldContinuationEnvelope(row.heldContinuation)
		const state = envelope?.profileAck
		if (
			!state ||
			state.role === 'tombstone' ||
			row.target !== marker.ref.target ||
			identity(state.ref) !== identity(marker.ref)
		)
			throw new ProfileAckConflict(
				'marker retirement retained a foreign or missing original native reference',
			)
		if (
			(state.role === 'coordinator') !==
			(row.dedupeKey === marker.ref.coordinatorKey)
		)
			throw new ProfileAckConflict(
				'marker retirement found a native pointer in the wrong original coordinator slot',
			)
		if (state.role === 'coordinator' && state.completion)
			throw new ProfileAckConflict(
				'a successful completed coordinator cannot retire an incomplete failure marker',
			)
		if (
			state.retirement &&
			(state.retirement.createdAt !== marker.createdAt ||
				state.retirement.expiresAt !== marker.expiresAt)
		)
			throw new ProfileAckConflict(
				'a later duplicate marker attempted to renew a retired native lifetime',
			)
		const updated: ProfileAck = {
			...state,
			retirement: state.retirement ?? args.retirement,
		}
		return {
			target: row.target,
			dedupeKey: row.dedupeKey,
			encoded: encodeHeldContinuationEnvelope({
				...envelope,
				profileAck: updated,
			}),
		}
	})
}
