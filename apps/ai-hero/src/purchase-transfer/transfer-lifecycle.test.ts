import { describe, expect, it } from 'vitest'

import {
	canTransitionTransfer,
	evaluateAccept,
	evaluateCancel,
	evaluateInitiate,
	isTerminalTransferState,
	isTransferExpired,
	TRANSFER_STATES,
	type TransferSnapshot,
} from './transfer-lifecycle'

const NOW = new Date('2026-08-24T12:00:00.000Z')
const FUTURE = new Date('2026-09-01T00:00:00.000Z')
const PAST = new Date('2026-08-01T00:00:00.000Z')

const baseTransfer = (
	overrides: Partial<TransferSnapshot> = {},
): TransferSnapshot => ({
	id: 'put_1',
	purchaseId: 'purchase_1',
	sourceUserId: 'user_source',
	targetUserId: null,
	transferState: 'AVAILABLE',
	expiresAt: FUTURE,
	...overrides,
})

describe('transition table', () => {
	it('allows only the modeled transitions', () => {
		const allowed = new Set([
			'AVAILABLE->INITIATED',
			'AVAILABLE->EXPIRED',
			'INITIATED->VERIFIED',
			'INITIATED->CANCELED',
			'INITIATED->EXPIRED',
			'VERIFIED->COMPLETED',
		])
		for (const from of TRANSFER_STATES) {
			for (const to of TRANSFER_STATES) {
				expect(canTransitionTransfer(from, to)).toBe(
					allowed.has(`${from}->${to}`),
				)
			}
		}
	})

	it('treats CANCELED, EXPIRED, CONFIRMED, and COMPLETED as terminal', () => {
		expect(isTerminalTransferState('CANCELED')).toBe(true)
		expect(isTerminalTransferState('EXPIRED')).toBe(true)
		expect(isTerminalTransferState('CONFIRMED')).toBe(true)
		expect(isTerminalTransferState('COMPLETED')).toBe(true)
		expect(isTerminalTransferState('AVAILABLE')).toBe(false)
		expect(isTerminalTransferState('INITIATED')).toBe(false)
		expect(isTerminalTransferState('VERIFIED')).toBe(false)
	})
})

describe('isTransferExpired', () => {
	it('is false with no expiry', () => {
		expect(isTransferExpired({ expiresAt: null }, NOW)).toBe(false)
	})
	it('is false before expiry and true after', () => {
		expect(isTransferExpired({ expiresAt: FUTURE }, NOW)).toBe(false)
		expect(isTransferExpired({ expiresAt: PAST }, NOW)).toBe(true)
	})
})

describe('evaluateInitiate', () => {
	const ok = {
		transfer: baseTransfer(),
		actorUserId: 'user_source',
		targetUserId: 'user_target',
		inFlightCountForPurchase: 0,
		now: NOW,
	}

	it('allows the source owner to initiate an AVAILABLE transfer', () => {
		expect(evaluateInitiate(ok)).toEqual({ ok: true })
	})

	it('denies anonymous callers', () => {
		expect(evaluateInitiate({ ...ok, actorUserId: null })).toMatchObject({
			ok: false,
			code: 'not_authenticated',
		})
	})

	it('denies a wrong user even with a valid transfer id', () => {
		expect(evaluateInitiate({ ...ok, actorUserId: 'user_c' })).toMatchObject({
			ok: false,
			code: 'not_source_owner',
		})
	})

	it('denies a missing transfer', () => {
		expect(evaluateInitiate({ ...ok, transfer: null })).toMatchObject({
			ok: false,
			code: 'not_found',
		})
	})

	it('denies non-AVAILABLE states', () => {
		for (const transferState of [
			'INITIATED',
			'VERIFIED',
			'CANCELED',
			'EXPIRED',
			'COMPLETED',
		]) {
			expect(
				evaluateInitiate({ ...ok, transfer: baseTransfer({ transferState }) }),
			).toMatchObject({ ok: false, code: 'invalid_state' })
		}
	})

	it('denies expired transfers and asks the caller to mark them', () => {
		expect(
			evaluateInitiate({ ...ok, transfer: baseTransfer({ expiresAt: PAST }) }),
		).toMatchObject({ ok: false, code: 'expired', markExpired: true })
	})

	it('denies transferring to yourself by user id', () => {
		expect(
			evaluateInitiate({ ...ok, targetUserId: 'user_source' }),
		).toMatchObject({ ok: false, code: 'self_transfer' })
	})

	it('denies transferring to your own email before user creation', () => {
		expect(
			evaluateInitiate({
				...ok,
				targetUserId: undefined,
				actorEmail: 'Source@Example.com',
				targetEmail: ' source@example.com ',
			}),
		).toMatchObject({ ok: false, code: 'self_transfer' })
	})

	it('denies a second transfer while one is in flight for the purchase', () => {
		expect(
			evaluateInitiate({ ...ok, inFlightCountForPurchase: 1 }),
		).toMatchObject({ ok: false, code: 'transfer_in_flight' })
	})
})

describe('evaluateCancel', () => {
	const initiated = baseTransfer({
		transferState: 'INITIATED',
		targetUserId: 'user_target',
	})

	it('allows the source owner to cancel an INITIATED transfer', () => {
		expect(
			evaluateCancel({ transfer: initiated, actorUserId: 'user_source' }),
		).toEqual({ ok: true })
	})

	it('denies anonymous and wrong users', () => {
		expect(
			evaluateCancel({ transfer: initiated, actorUserId: null }),
		).toMatchObject({ ok: false, code: 'not_authenticated' })
		expect(
			evaluateCancel({ transfer: initiated, actorUserId: 'user_target' }),
		).toMatchObject({ ok: false, code: 'not_source_owner' })
	})

	it('denies double cancel (already CANCELED)', () => {
		expect(
			evaluateCancel({
				transfer: baseTransfer({ transferState: 'CANCELED' }),
				actorUserId: 'user_source',
			}),
		).toMatchObject({ ok: false, code: 'invalid_state' })
	})

	it('denies cancel after acceptance (VERIFIED/COMPLETED)', () => {
		for (const transferState of ['VERIFIED', 'COMPLETED']) {
			expect(
				evaluateCancel({
					transfer: baseTransfer({ transferState }),
					actorUserId: 'user_source',
				}),
			).toMatchObject({ ok: false, code: 'invalid_state' })
		}
	})
})

describe('evaluateAccept', () => {
	const initiated = baseTransfer({
		transferState: 'INITIATED',
		targetUserId: 'user_target',
	})

	it('allows the target of an INITIATED transfer', () => {
		expect(
			evaluateAccept({
				transfer: initiated,
				actorUserId: 'user_target',
				now: NOW,
			}),
		).toEqual({ ok: true, kind: 'accept' })
	})

	it('denies anonymous callers', () => {
		expect(
			evaluateAccept({ transfer: initiated, actorUserId: null }),
		).toMatchObject({ ok: false, code: 'not_authenticated' })
	})

	it('denies a wrong user (leaked claim link holder)', () => {
		expect(
			evaluateAccept({ transfer: initiated, actorUserId: 'user_c' }),
		).toMatchObject({ ok: false, code: 'not_target_user' })
	})

	it('resumes a VERIFIED claim held by the same target (in-flight, not terminal)', () => {
		expect(
			evaluateAccept({
				transfer: baseTransfer({
					transferState: 'VERIFIED',
					targetUserId: 'user_target',
				}),
				actorUserId: 'user_target',
			}),
		).toEqual({ ok: true, kind: 'resume' })
	})

	it('is an idempotent replay when already COMPLETED for the same target', () => {
		expect(
			evaluateAccept({
				transfer: baseTransfer({
					transferState: 'COMPLETED',
					targetUserId: 'user_target',
				}),
				actorUserId: 'user_target',
			}),
		).toEqual({ ok: true, kind: 'replay' })
	})

	it('never resumes or replays an expired-looking VERIFIED claim as expired', () => {
		// A VERIFIED claim was accepted in time; expiry no longer applies.
		expect(
			evaluateAccept({
				transfer: baseTransfer({
					transferState: 'VERIFIED',
					targetUserId: 'user_target',
					expiresAt: PAST,
				}),
				actorUserId: 'user_target',
				now: NOW,
			}),
		).toEqual({ ok: true, kind: 'resume' })
	})

	it('denies replay by a different user even when VERIFIED', () => {
		expect(
			evaluateAccept({
				transfer: baseTransfer({
					transferState: 'VERIFIED',
					targetUserId: 'user_target',
				}),
				actorUserId: 'user_c',
			}),
		).toMatchObject({ ok: false, code: 'not_target_user' })
	})

	it('denies accept after cancel', () => {
		expect(
			evaluateAccept({
				transfer: baseTransfer({
					transferState: 'CANCELED',
					targetUserId: 'user_target',
				}),
				actorUserId: 'user_target',
			}),
		).toMatchObject({ ok: false, code: 'invalid_state' })
	})

	it('denies expired transfers and asks the caller to mark them', () => {
		expect(
			evaluateAccept({
				transfer: baseTransfer({
					transferState: 'INITIATED',
					targetUserId: 'user_target',
					expiresAt: PAST,
				}),
				actorUserId: 'user_target',
				now: NOW,
			}),
		).toMatchObject({ ok: false, code: 'expired', markExpired: true })
	})
})
