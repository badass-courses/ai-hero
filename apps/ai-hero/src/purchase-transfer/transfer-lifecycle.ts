/**
 * Pure purchase-transfer lifecycle model (AIH-223 / AIH-209).
 *
 * The database enum is fixed by @coursebuilder/adapter-drizzle:
 * AVAILABLE, INITIATED, VERIFIED, CANCELED, EXPIRED, CONFIRMED, COMPLETED.
 * This module owns which transitions are legal and who may request them.
 * Persistence layers must pair every transition with a compare-and-swap
 * `WHERE transferState = <from>` guard so a lost race can never overwrite
 * a terminal state.
 */

export const TRANSFER_STATES = [
	'AVAILABLE',
	'INITIATED',
	'VERIFIED',
	'CANCELED',
	'EXPIRED',
	'CONFIRMED',
	'COMPLETED',
] as const

export type TransferState = (typeof TRANSFER_STATES)[number]

/**
 * A purchase may have at most one transfer row in these states. AVAILABLE
 * rows are idle slots, not in-flight transfers.
 */
export const IN_FLIGHT_TRANSFER_STATES = ['INITIATED', 'VERIFIED'] as const

/** States that still block creating a replacement AVAILABLE slot. */
export const OPEN_TRANSFER_STATES = [
	'AVAILABLE',
	'INITIATED',
	'VERIFIED',
] as const

const TRANSFER_TRANSITIONS: Record<TransferState, readonly TransferState[]> = {
	AVAILABLE: ['INITIATED', 'EXPIRED'],
	INITIATED: ['VERIFIED', 'CANCELED', 'EXPIRED'],
	VERIFIED: ['COMPLETED'],
	// CONFIRMED is a legacy value some historical rows carry; treat as terminal.
	CONFIRMED: [],
	CANCELED: [],
	EXPIRED: [],
	COMPLETED: [],
}

export function canTransitionTransfer(
	from: TransferState,
	to: TransferState,
): boolean {
	return TRANSFER_TRANSITIONS[from]?.includes(to) ?? false
}

export function isTerminalTransferState(state: TransferState): boolean {
	return TRANSFER_TRANSITIONS[state].length === 0
}

export interface TransferSnapshot {
	id: string
	purchaseId: string
	sourceUserId: string
	targetUserId?: string | null
	transferState: string
	expiresAt?: Date | null
}

export function isTransferExpired(
	transfer: Pick<TransferSnapshot, 'expiresAt'>,
	now: Date = new Date(),
): boolean {
	return Boolean(transfer.expiresAt && transfer.expiresAt < now)
}

export type TransferDenialCode =
	| 'not_found'
	| 'not_authenticated'
	| 'not_source_owner'
	| 'not_target_user'
	| 'invalid_state'
	| 'invalid_email'
	| 'expired'
	| 'self_transfer'
	| 'transfer_in_flight'

export type TransferDenial = {
	ok: false
	code: TransferDenialCode
	/** The caller should also compare-and-swap the row to EXPIRED. */
	markExpired?: boolean
}

export type InitiateDecision = { ok: true } | TransferDenial

export type CancelDecision = { ok: true } | TransferDenial

export type AcceptDecision =
	| { ok: true; kind: 'accept' }
	/**
	 * The claim is already this target's (VERIFIED) but the transfer has not
	 * completed. VERIFIED is a resumable in-flight claim: the caller must
	 * re-run the idempotent completion work (Stripe, ownership, outbox,
	 * publish) so a crash at any point converges on re-accept.
	 */
	| { ok: true; kind: 'resume' }
	/** The transfer is terminal for this target; succeed with no new work. */
	| { ok: true; kind: 'replay' }
	| TransferDenial

export const TRANSFER_DENIAL_MESSAGES: Record<TransferDenialCode, string> = {
	not_found: 'No purchaseUserTransfer found',
	not_authenticated: 'You must be signed in',
	not_source_owner: 'Only the purchase owner can manage this transfer',
	not_target_user: 'You are not the target user',
	invalid_state: 'This transfer is not available',
	invalid_email:
		'That email address does not look valid. Check it and try again.',
	expired: 'This transfer has expired',
	self_transfer: 'You cannot transfer a purchase to yourself',
	transfer_in_flight: 'A transfer is already in progress for this purchase',
}

export function evaluateInitiate(params: {
	transfer: TransferSnapshot | null | undefined
	actorUserId: string | null | undefined
	targetUserId?: string | null
	targetEmail?: string | null
	actorEmail?: string | null
	inFlightCountForPurchase: number
	now?: Date
}): InitiateDecision {
	const { transfer, actorUserId, now = new Date() } = params
	if (!actorUserId) return { ok: false, code: 'not_authenticated' }
	if (!transfer) return { ok: false, code: 'not_found' }
	if (transfer.sourceUserId !== actorUserId)
		return { ok: false, code: 'not_source_owner' }
	if (transfer.transferState !== 'AVAILABLE')
		return { ok: false, code: 'invalid_state' }
	if (isTransferExpired(transfer, now))
		return { ok: false, code: 'expired', markExpired: true }
	if (
		params.targetEmail &&
		params.actorEmail &&
		params.targetEmail.trim().toLowerCase() ===
			params.actorEmail.trim().toLowerCase()
	) {
		return { ok: false, code: 'self_transfer' }
	}
	if (params.targetUserId && params.targetUserId === actorUserId)
		return { ok: false, code: 'self_transfer' }
	if (params.inFlightCountForPurchase > 0)
		return { ok: false, code: 'transfer_in_flight' }
	return { ok: true }
}

export function evaluateCancel(params: {
	transfer: TransferSnapshot | null | undefined
	actorUserId: string | null | undefined
}): CancelDecision {
	const { transfer, actorUserId } = params
	if (!actorUserId) return { ok: false, code: 'not_authenticated' }
	if (!transfer) return { ok: false, code: 'not_found' }
	if (transfer.sourceUserId !== actorUserId)
		return { ok: false, code: 'not_source_owner' }
	if (transfer.transferState !== 'INITIATED')
		return { ok: false, code: 'invalid_state' }
	return { ok: true }
}

export function evaluateAccept(params: {
	transfer: TransferSnapshot | null | undefined
	actorUserId: string | null | undefined
	now?: Date
}): AcceptDecision {
	const { transfer, actorUserId, now = new Date() } = params
	if (!actorUserId) return { ok: false, code: 'not_authenticated' }
	if (!transfer) return { ok: false, code: 'not_found' }
	if (transfer.targetUserId !== actorUserId)
		return { ok: false, code: 'not_target_user' }
	if (transfer.transferState === 'VERIFIED') {
		return { ok: true, kind: 'resume' }
	}
	if (transfer.transferState === 'COMPLETED') {
		return { ok: true, kind: 'replay' }
	}
	if (transfer.transferState !== 'INITIATED')
		return { ok: false, code: 'invalid_state' }
	if (isTransferExpired(transfer, now))
		return { ok: false, code: 'expired', markExpired: true }
	return { ok: true, kind: 'accept' }
}

export function transferDenialError(denial: TransferDenial): Error {
	return new Error(TRANSFER_DENIAL_MESSAGES[denial.code])
}
