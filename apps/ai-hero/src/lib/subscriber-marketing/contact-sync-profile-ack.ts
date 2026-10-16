import { createHash } from 'node:crypto'
import { NonRetriableError } from 'inngest'
import { drovrOutboxDedupeKey, type DrovrOutboxRow } from './drovr-outbox'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import {
	encodeHeldContinuationEnvelope,
	readHeldContinuationEnvelope,
} from './drovr-outbox-control'
import {
	AckEvidenceExpired,
	PROFILE_ACK_MAX_REFERENCES,
	type ProfileAckCoordinator,
	type ProfileAckMember,
	type ProfileAckReference,
} from './contact-sync-profile-ack-schema'

export class ProfileAckConflict extends NonRetriableError {
	readonly _tag = 'ProfileAckConflict'
	constructor(reason: string) {
		super(
			`ProfileAckConflict: you attempted a profile acknowledgement, and it failed because ${reason}. Accepted: the exact first frozen request and kind, one immutable delivered proof, and a forward-only confirmationClock. Fix: inspect the retained first request and SDK receipts; do not rebuild history, refresh age from retry time, or replace a conflicting proof. Debug: PROFILE ACK FIRST PROOF WINS; no acknowledgement or timestamp change is authorized by this refusal.`,
		)
	}
}
const fail = (reason: string): never => {
	throw new ProfileAckConflict(reason)
}
const instant = (value: unknown): value is string =>
	typeof value === 'string' &&
	Number.isFinite(Date.parse(value)) &&
	new Date(Date.parse(value)).toISOString() === value
function canonical(value: unknown): string {
	if (value === null) return 'null'
	if (typeof value === 'string' || typeof value === 'boolean')
		return JSON.stringify(value)
	if (typeof value === 'number' && Number.isFinite(value))
		return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (
		typeof value === 'object' &&
		value !== null &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	)
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
			)
			.join(',')}}`
	return fail('retained first-body evidence is not canonical JSON')
}
const digest = (value: unknown) =>
	createHash('sha256').update(canonical(value)).digest('hex')

function member(
	row: DrovrOutboxRow,
	scope: Pick<ProfileAckReference, 'target' | 'contactId' | 'profileVersion'>,
): ProfileAckMember {
	if (
		row.target !== scope.target ||
		row.endpoint !== 'events' ||
		row.tenantId !== 'org-aihero' ||
		row.contactId !== scope.contactId ||
		row.journeyId !== 'contact-directory' ||
		row.needsFanOut ||
		row.queueMetadataInvalid ||
		row.dedupeKey !== drovrOutboxDedupeKey(scope.target, row)
	)
		return fail('a frozen member has an invalid full scoped ownership row')
	if (row.source !== 'bulkDelta' && row.source !== 'bulkRestate')
		return fail(
			'a first-owned member is not a supported capped profile source; its original class cannot be replaced',
		)
	const body = row.body as DrovrShadowEvent
	if (
		!body ||
		typeof body !== 'object' ||
		body.tenantId !== row.tenantId ||
		body.contactId !== row.contactId ||
		body.journeyId !== row.journeyId ||
		body.idempotencyKey !== row.idempotencyKey ||
		body.type !== row.eventType ||
		body.occurredAt !== row.occurredAt ||
		!instant(body.occurredAt) ||
		!instant(row.firstFailedAt)
	)
		return fail(
			'a first body or clock does not match its immutable member scope',
		)
	if (
		body.type !== 'contact.profile.updated' &&
		body.type !== 'contact.links.issued'
	)
		return fail('a profile request contains a foreign event family')
	const payload = body.payload as Record<string, unknown> | undefined
	if (
		!payload ||
		typeof payload !== 'object' ||
		Array.isArray(payload) ||
		payload.profileVersion !== scope.profileVersion
	)
		return fail('a first body does not match the frozen profile version')
	if (
		body.type === 'contact.links.issued' &&
		(typeof payload.journeyId !== 'string' ||
			!payload.journeyId ||
			typeof payload.emailKey !== 'string' ||
			!payload.emailKey ||
			body.idempotencyKey !==
				`links:${scope.contactId}:${payload.journeyId}:${payload.emailKey}:v${scope.profileVersion}`)
	)
		return fail('a link lacks its exact canonical first-owned slot key')
	return {
		key: row.dedupeKey,
		eventType: body.type,
		bodyHash: digest(body),
		firstFailedAt: row.firstFailedAt,
	}
}
/** Read-only first-owned member check, including when unrelated evidence has
 * expired. This grants neither transport nor ACK authority. */
export function assertProfileAckRetainedMember(state: ProfileAckCoordinator, row: DrovrOutboxRow): void {
	const expected = state.members.find(item => item.key === row.dedupeKey)
	if (!expected || canonical(member(row, state.ref)) !== canonical(expected)) fail('a retained native member changed its original frozen body, scope or clock')
}
function requestFor(
	profile: DrovrOutboxRow,
	version: number,
): ProfileAckReference['request'] {
	const base = `profile:${profile.contactId}:${version}`
	if (profile.idempotencyKey === base) return { kind: 'delta' }
	const period = profile.idempotencyKey.slice(`${base}:restate:`.length)
	if (
		profile.idempotencyKey === `${base}:restate:${period}` &&
		/^\d{4}-(0[1-9]|1[0-2])$/.test(period) &&
		profile.occurredAt.slice(0, 7) === period
	)
		return { kind: 'restate', period }
	return fail(
		'the profile key does not identify the original delta or its explicit frozen restatement period',
	)
}
/** Called only with retained first-owned rows, never a new current snapshot.
 * Source is committed into requestId, independently of wire dedupe identity. */
export function freezeProfileAckRequest(args: {
	target: string
	contactId: string
	profileVersion: number
	registeredAt: string
	rows: readonly DrovrOutboxRow[]
}): ProfileAckCoordinator {
	if (
		!args.rows.length ||
		args.rows.length > PROFILE_ACK_MAX_REFERENCES ||
		new Set(args.rows.map((row) => row.dedupeKey)).size !== args.rows.length
	)
		return fail(
			'the frozen membership is empty, duplicated or exceeds its bounded reference budget',
		)
	const rows = [...args.rows].sort((a, b) =>
		a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0,
	)
	const members = rows.map((row) => member(row, args))
	const profiles = rows.filter(
		(row) => row.eventType === 'contact.profile.updated',
	)
	if (profiles.length !== 1)
		return fail('the frozen request must contain exactly one matching profile')
	const profile = profiles[0]!
	if (rows.some((row) => row.source !== profile.source))
		return fail(
			'the frozen request contains conflicting first-owned delivery classes',
		)
	const request = requestFor(profile, args.profileVersion)
	if (request.kind === 'restate' && rows.length !== 1)
		return fail(
			'an acknowledged monthly confirmation cannot smuggle a changed link membership',
		)
	const scope = {
		target: args.target,
		endpoint: 'events' as const,
		tenantId: 'org-aihero' as const,
		contactId: args.contactId,
		journeyId: 'contact-directory' as const,
		profileVersion: args.profileVersion,
		coordinatorKey: profile.dedupeKey,
		request,
	}
	const requestId = digest({
		scope,
		members,
		sources: rows.map((row) => ({ key: row.dedupeKey, source: row.source })),
	})
	const value = {
		v: 1 as const,
		role: 'coordinator' as const,
		ref: { ...scope, requestId },
		registeredAt: args.registeredAt,
		members,
	}
	try {
		const result = readHeldContinuationEnvelope(
			encodeHeldContinuationEnvelope({ v: 1, profileAck: value }),
		)!.profileAck!
		if (result.role !== 'coordinator')
			return fail('the frozen request has no coordinator role')
		return result
	} catch (error) {
		if (error instanceof ProfileAckConflict) throw error
		return fail(
			'the frozen profile ACK schema, clock or byte bound is invalid; no references may be truncated',
		)
	}
}
export type ProfileAckProof = {
	proofId: string
	confirmationClock: string
	provedAt: string
}
export type ProfileAckEvaluation =
	| AckEvidenceExpired
	| {
			_tag: 'ProfileAckWaiting'
			reason: 'blocked' | 'unfinished' | 'missing-receipt'
	  }
	| { _tag: 'ProfileAckReceiverRefused' }
	| {
			_tag: 'ProfileAckReady'
			proof: ProfileAckProof
			alreadyCompleted: boolean
	  }
export const expiredProfileAck = (
	ref: ProfileAckReference,
): AckEvidenceExpired =>
	AckEvidenceExpired.make({
		v: 1,
		target: ref.target,
		contactId: ref.contactId,
		profileVersion: ref.profileVersion,
		requestId: ref.requestId,
	})

/** Evaluate an ACK only. An expired ACK never abandons retained native debt.
 * No application execution clock and no lastError input participates. */
export function evaluateProfileAckCompletion(
	state: ProfileAckCoordinator,
	rows: readonly DrovrOutboxRow[],
): ProfileAckEvaluation {
	const keys = state.members.map((item) => item.key)
	if (
		new Set(rows.map((row) => row.dedupeKey)).size !== rows.length ||
		rows.some(
			(row) => row.target !== state.ref.target || !keys.includes(row.dedupeKey),
		)
	)
		return fail(
			'the completion read returned duplicate, foreign or unscoped evidence',
		)
	if (rows.length !== keys.length) return expiredProfileAck(state.ref)
	if (
		rows.some(
			(row) =>
				row.heldBatchBlocked ||
				row.queueMetadataInvalid ||
				row.needsFanOut ||
				row.status === 'held',
		)
	)
		return { _tag: 'ProfileAckWaiting', reason: 'blocked' }
	const frozen = freezeProfileAckRequest({
		target: state.ref.target,
		contactId: state.ref.contactId,
		profileVersion: state.ref.profileVersion,
		registeredAt: state.registeredAt,
		rows,
	})
	if (
		frozen.ref.requestId !== state.ref.requestId ||
		canonical(frozen.members) !== canonical(state.members)
	)
		return fail(
			'a different first-body, source, clock or membership proof attempted the same frozen request',
		)
	if (rows.some((row) => row.status === 'rejected'))
		return { _tag: 'ProfileAckReceiverRefused' }
	if (rows.some((row) => row.status !== 'delivered'))
		return { _tag: 'ProfileAckWaiting', reason: 'unfinished' }
	if (rows.some((row) => !instant(row.deliveredAt)))
		return { _tag: 'ProfileAckWaiting', reason: 'missing-receipt' }
	const receipts = [...rows]
		.sort((a, b) =>
			a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0,
		)
		.map((row) => ({ key: row.dedupeKey, deliveredAt: row.deliveredAt! }))
	const profile = rows.find(
		(row) => row.dedupeKey === state.ref.coordinatorKey,
	)!
	const confirmationClock = profile.occurredAt
	const provedAt = new Date(
		Math.max(...receipts.map((receipt) => Date.parse(receipt.deliveredAt))),
	).toISOString()
	const proofId = digest({
		requestId: state.ref.requestId,
		confirmationClock,
		provedAt,
		receipts,
	})
	const proof = { proofId, confirmationClock, provedAt }
	if (
		state.completion &&
		(state.completion.proofId !== proofId ||
			state.completion.confirmationClock !== confirmationClock ||
			state.completion.provedAt !== provedAt)
	)
		return fail(
			'a different delivered proof attempted to replace the first completed proof for the same request',
		)
	return {
		_tag: 'ProfileAckReady',
		proof,
		alreadyCompleted: state.completion !== undefined,
	}
}
/** This is the only confirmation-age input. provedAt is audit, never age. */
export function profileAckConfirmationClock(
	proof: ProfileAckProof,
	previous: string | null | undefined,
): string {
	const candidate = proof.confirmationClock
	if (!instant(candidate) || (previous != null && !instant(previous)))
		return fail('the confirmation clock is invalid')
	if (previous != null && Date.parse(candidate) < Date.parse(previous))
		return fail('CONFIRMATION CLOCK WOULD MOVE BACKWARD')
	return candidate
}
