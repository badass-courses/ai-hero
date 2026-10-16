import { createHash } from 'node:crypto'
import { Either, Schema } from 'effect'
import { NonRetriableError } from 'inngest'
import { drovrOutboxDedupeKey } from './drovr-outbox'
import {
	encodeHeldContinuationEnvelope,
	readHeldContinuationEnvelope,
} from './drovr-outbox-control'
import {
	ACK_TOMBSTONE_ENDPOINT,
	ACK_TOMBSTONE_EVENT_TYPE,
	ACK_TOMBSTONE_MAX_AGE_MS,
	ACK_TOMBSTONE_SOURCE,
	ACK_TOMBSTONE_STATUS,
	AckTombstoneBody,
	type ProfileAckIdentity,
	type ProfileAckReference,
	type ProfileAckTombstone,
} from './contact-sync-profile-ack-schema'

export class AckTombstoneControlError extends NonRetriableError {
	readonly _tag = 'AckTombstoneControl'
	constructor(reason: string) {
		super(
			`AckTombstoneControl: you attempted ACK tombstone coordination, and it failed because ${reason}. Accepted: a scoped v1 metadata-only failed-ACK record, fixed sentinel, first-created expiry of 400 days and a positive current version. Fix: inspect the retained control record and reader rollout; never dispatch it, reconstruct native history or extend its expiry. Debug: keep drovr-profile-ack-enabled OFF until all reader fences have deployment proof; no wire receipt, ACK or purge is authorized by this refusal.`,
		)
	}
}
const fail = (reason: string): never => {
	throw new AckTombstoneControlError(reason)
}
const instant = (value: unknown): value is string =>
	typeof value === 'string' &&
	Number.isFinite(Date.parse(value)) &&
	new Date(Date.parse(value)).toISOString() === value
function storedInstant(value: unknown): string {
	if (value instanceof Date) return value.toISOString()
	if (typeof value !== 'string')
		return fail('the stored first-created clock is absent')
	return /(Z|[+-]\d{2}:?\d{2})$/.test(value)
		? new Date(value).toISOString()
		: new Date(`${value.replace(' ', 'T')}Z`).toISOString()
}
export const ackTombstoneIdempotencyKey = (ref: ProfileAckIdentity) =>
	`profile-ack:${ref.coordinatorKey}`
/** Stable LOGICAL request key: a changed body/proof cannot mint a second row
 * and bypass the first frozen request's tombstone. Source is not wire dedupe. */
export function ackTombstoneKey(ref: ProfileAckIdentity): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				ref.target,
				ACK_TOMBSTONE_ENDPOINT,
				ref.tenantId,
				ref.contactId,
				ref.journeyId,
				ackTombstoneIdempotencyKey(ref),
			]),
		)
		.digest('hex')
}
function assertRef(ref: ProfileAckIdentity): void {
	const idempotencyKey = `profile:${ref.contactId}:${ref.profileVersion}${ref.request.kind === 'restate' ? `:restate:${ref.request.period}` : ''}`
	const key = drovrOutboxDedupeKey(ref.target, {
		endpoint: 'events',
		tenantId: ref.tenantId,
		contactId: ref.contactId,
		journeyId: ref.journeyId,
		idempotencyKey,
	})
	if (key !== ref.coordinatorKey)
		fail(
			'the native coordinator key does not bind this exact contact, version and request kind',
		)
}
export function makeAckTombstone(
	ref: ProfileAckReference,
	args: { createdAt: string; reason: ProfileAckTombstone['reason'] },
): ProfileAckTombstone {
	assertRef(ref)
	if (
		!instant(args.createdAt) ||
		!Number.isFinite(
			new Date(Date.parse(args.createdAt) + ACK_TOMBSTONE_MAX_AGE_MS).getTime(),
		)
	)
		return fail('the first-created expiry clock is invalid')
	const value = {
		v: 1 as const,
		role: 'tombstone' as const,
		ref,
		createdAt: args.createdAt,
		expiresAt: new Date(
			Date.parse(args.createdAt) + ACK_TOMBSTONE_MAX_AGE_MS,
		).toISOString(),
		reason: args.reason,
	}
	try {
		const result = readHeldContinuationEnvelope(
			encodeHeldContinuationEnvelope({ v: 1, profileAck: value }),
		)!.profileAck!
		if (result.role !== 'tombstone')
			return fail('the decoded record is not a tombstone')
		return result
	} catch (error) {
		if (error instanceof AckTombstoneControlError) throw error
		return fail('the metadata schema, scope or byte bound is invalid')
	}
}
/** Repeated bookkeeping preserves the first expiry/proof/cause. Purge may only
 * monotonically fence that identity as expired; never revive its evidence. */
export function retainAckTombstone(
	existing: ProfileAckTombstone,
	incoming: ProfileAckTombstone,
): ProfileAckTombstone {
	assertRef(existing.ref)
	assertRef(incoming.ref)
	if (
		ackTombstoneKey(existing.ref) !== ackTombstoneKey(incoming.ref) ||
		existing.ref.requestId !== incoming.ref.requestId
	)
		return fail(
			'a different frozen request/proof attempted to replace the first tombstone',
		)
	if (
		existing.reason !== 'expired-evidence' &&
		!existing.evidenceExpired &&
		(incoming.reason === 'expired-evidence' || incoming.evidenceExpired)
	)
		return { ...existing, evidenceExpired: true }
	return existing
}
/** Separate from the native DTO decoder. Never normalizes a sentinel into an
 * event, and never reads diagnostic prose as an operational instruction. */
export function readAckTombstone(
	row: Record<string, unknown>,
): ProfileAckTombstone {
	try {
		if (
			row.status !== ACK_TOMBSTONE_STATUS ||
			row.source !== ACK_TOMBSTONE_SOURCE ||
			row.endpoint !== ACK_TOMBSTONE_ENDPOINT ||
			row.eventType !== ACK_TOMBSTONE_EVENT_TYPE ||
			row.needsFanOut !== false ||
			row.deliveredAt != null ||
			row.lastStatus != null ||
			row.lastAttemptAt != null ||
			row.releasedAt != null ||
			row.attempts !== 0
		)
			return fail('the control-only row has wire dispatch or receipt fields')
		const body = typeof row.body === 'string' ? JSON.parse(row.body) : row.body
		if (
			Either.isLeft(
				Schema.decodeUnknownEither(AckTombstoneBody, {
					onExcessProperty: 'error',
				})(body),
			)
		)
			return fail('the NOT NULL body is not the exact fixed sentinel')
		const state = readHeldContinuationEnvelope(row.heldContinuation)?.profileAck
		if (!state || state.role !== 'tombstone')
			return fail('the typed profileAck tombstone is absent or malformed')
		assertRef(state.ref)
		if (storedInstant(row.createdAt) !== state.createdAt)
			return fail(
				'the metadata expiry was rebased away from the row first-created clock',
			)
		if (
			row.target !== state.ref.target ||
			row.contactId !== state.ref.contactId ||
			row.tenantId !== state.ref.tenantId ||
			row.journeyId !== state.ref.journeyId ||
			row.dedupeKey !== ackTombstoneKey(state.ref) ||
			row.idempotencyKey !== ackTombstoneIdempotencyKey(state.ref)
		)
			return fail('the tombstone scope does not match its stored full key')
		return state
	} catch (error) {
		if (error instanceof AckTombstoneControlError) throw error
		return fail(
			'the sentinel or dedicated control column cannot be decoded; no diagnostic fallback is permitted',
		)
	}
}
/** No native delivered-row pin and no implicit generic purge. Missing current
 * version is not positive version-change proof; an unavailable read must throw. */
export function shouldPurgeAckTombstone(
	state: ProfileAckTombstone,
	args: { now: number; currentVersion?: number },
): boolean {
	if (
		!Number.isFinite(args.now) ||
		(args.currentVersion !== undefined &&
			(!Number.isSafeInteger(args.currentVersion) || args.currentVersion < 1))
	)
		return fail('the purge clock or current version is invalid')
	return (
		(args.currentVersion !== undefined &&
			args.currentVersion !== state.ref.profileVersion) ||
		args.now >= Date.parse(state.expiresAt)
	)
}
