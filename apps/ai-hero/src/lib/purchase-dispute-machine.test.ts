import { describe, expect, it } from 'vitest'

import { readPurchaseDisputeLifecycle } from '@coursebuilder/commerce/dispute-lifecycle'

import {
	decideDisputeTransition,
	readDisputeRecord,
	type PurchaseDisputeRecord,
} from './purchase-dispute-machine'

const record = (
	overrides: Partial<PurchaseDisputeRecord> = {},
): PurchaseDisputeRecord => ({
	stripeDisputeId: 'du_1',
	state: 'open',
	originalStatus: 'Restricted',
	openedAt: '2026-10-09T12:00:00.000Z',
	revokedEntitlementIds: ['content'],
	discordRoleIds: [],
	discordSync: {},
	...overrides,
})

const decide = (
	args: Partial<Parameters<typeof decideDisputeTransition>[0]> &
		Pick<Parameters<typeof decideDisputeTransition>[0], 'event'>,
) =>
	decideDisputeTransition({
		record: undefined,
		stripeDisputeId: 'du_1',
		purchaseStatus: 'Restricted',
		...args,
	})

describe('decideDisputeTransition', () => {
	it('opened from none cuts access and persists the status it interrupted', () => {
		expect(decide({ event: 'opened' })).toMatchObject({
			kind: 'applied',
			createRecord: true,
			from: null,
			to: 'open',
			originalStatus: 'Restricted',
			cut: true,
			status: 'Disputed',
		})
	})

	it('trusts what commerce read when it already wrote Disputed', () => {
		expect(
			decide({
				event: 'opened',
				purchaseStatus: 'Disputed',
				eventPreviousStatus: 'Restricted',
			}),
		).toMatchObject({ originalStatus: 'Restricted', status: null })
	})

	it('records an unknown original status instead of guessing Valid', () => {
		expect(
			decide({
				event: 'opened',
				purchaseStatus: 'Disputed',
				eventPreviousStatus: 'Disputed',
			}),
		).toMatchObject({ originalStatus: null })
		expect(
			decide({
				event: 'won',
				record: record({ originalStatus: null }),
				purchaseStatus: 'Disputed',
			}),
		).toMatchObject({
			to: 'won',
			restore: true,
			status: null,
			statusHeld: 'original-status-unknown',
		})
	})

	it('won before opened records a terminal win and cuts nothing', () => {
		expect(decide({ event: 'won' })).toMatchObject({
			kind: 'applied',
			to: 'won',
			cut: false,
			restore: false,
			status: null,
		})
	})

	it('a late opened after a win changes nothing but repairs the status', () => {
		const won = record({ state: 'won' })
		expect(decide({ event: 'opened', record: won })).toMatchObject({
			kind: 'unchanged',
			to: 'won',
			cut: false,
		})
		expect(
			decide({ event: 'opened', record: won, purchaseStatus: 'Disputed' }),
		).toMatchObject({ kind: 'repaired', status: 'Restricted' })
		expect(
			decide({ event: 'reconcile', record: won, purchaseStatus: 'Disputed' }),
		).toMatchObject({ kind: 'repaired', status: 'Restricted' })
	})

	it('won restores, lost blocks, and both are terminal', () => {
		expect(
			decide({ event: 'won', record: record(), purchaseStatus: 'Disputed' }),
		).toMatchObject({ to: 'won', restore: true, status: 'Restricted' })
		expect(
			decide({ event: 'lost', record: record(), purchaseStatus: 'Disputed' }),
		).toMatchObject({ to: 'lost', blockBuyer: true, status: null })
		expect(
			decide({
				event: 'won',
				record: record({
					state: 'lost',
					buyer: { status: 'blocked', userId: 'u', alreadyBlocked: false },
				}),
				purchaseStatus: 'Disputed',
			}),
		).toMatchObject({ kind: 'unchanged', reason: 'closed-lost', to: 'lost' })
	})

	it('lost from none cuts and blocks', () => {
		expect(decide({ event: 'lost' })).toMatchObject({
			to: 'lost',
			cut: true,
			blockBuyer: true,
			status: 'Disputed',
		})
	})

	describe('refund overrides every state', () => {
		it('a recorded refund holds Refunded even after the status was overwritten', () => {
			expect(
				decide({
					event: 'won',
					record: record({ refundedAt: '2026-10-10T00:00:00.000Z' }),
					purchaseStatus: 'Disputed',
				}),
			).toMatchObject({ to: 'won', restore: false, status: 'Refunded' })
		})

		it('a Refunded status is recorded and never restored', () => {
			expect(
				decide({ event: 'won', record: record(), purchaseStatus: 'Refunded' }),
			).toMatchObject({
				to: 'won',
				restore: false,
				status: null,
				markRefunded: true,
			})
		})

		it('opened or lost on a refunded purchase cuts nothing more', () => {
			expect(
				decide({ event: 'opened', purchaseStatus: 'Refunded' }),
			).toMatchObject({ cut: false, status: null })
			expect(
				decide({ event: 'lost', purchaseStatus: 'Refunded' }),
			).toMatchObject({ cut: false, blockBuyer: true, status: null })
		})
	})

	it('an opened payload upgrades an unknown original status, a closed one never does', () => {
		const unknown = record({ originalStatus: null })
		expect(
			decide({
				event: 'opened',
				record: unknown,
				purchaseStatus: 'Disputed',
				eventPreviousStatus: 'Restricted',
			}),
		).toMatchObject({ kind: 'repaired', originalStatus: 'Restricted' })
		expect(
			decide({
				event: 'opened',
				record: record({ state: 'won', originalStatus: null }),
				purchaseStatus: 'Disputed',
				eventPreviousStatus: 'Restricted',
			}),
		).toMatchObject({ status: 'Restricted' })
		expect(
			decide({
				event: 'won',
				record: unknown,
				purchaseStatus: 'Disputed',
				eventPreviousStatus: 'Valid',
			}),
		).toMatchObject({
			originalStatus: null,
			statusHeld: 'original-status-unknown',
		})
	})

	it('a Banned status during a dispute stops restoration and status writes', () => {
		expect(
			decide({ event: 'won', record: record(), purchaseStatus: 'Banned' }),
		).toMatchObject({
			to: 'won',
			restore: false,
			restoreHeld: 'banned',
			status: null,
			markBanned: true,
		})
		expect(
			decide({
				event: 'won',
				record: record({ bannedAt: '2026-10-10T00:00:00.000Z' }),
				purchaseStatus: 'Disputed',
			}),
		).toMatchObject({ restore: false, status: null })
		expect(
			decide({ event: 'opened', record: record(), purchaseStatus: 'Banned' }),
		).toMatchObject({ status: null })
	})

	it('retries a held buyer block on later events', () => {
		expect(
			decide({
				event: 'reconcile',
				record: record({
					state: 'lost',
					buyer: { status: 'held', reason: 'transfer-chain-ambiguous' },
				}),
				purchaseStatus: 'Disputed',
			}),
		).toMatchObject({ kind: 'applied', blockBuyer: true })
	})

	it('ignores other disputes, Banned purchases and reconcile without a record', () => {
		expect(
			decide({ event: 'won', record: record({ stripeDisputeId: 'du_2' }) }),
		).toEqual({ kind: 'ignored', reason: 'different-dispute' })
		expect(decide({ event: 'opened', purchaseStatus: 'Banned' })).toEqual({
			kind: 'ignored',
			reason: 'status-Banned',
		})
		expect(decide({ event: 'reconcile' })).toEqual({
			kind: 'ignored',
			reason: 'no-record',
		})
	})
})

describe('commerce lifecycle contract', () => {
	it('commerce reads the state and refund marker from the app record', () => {
		const refunded = record({
			state: 'won',
			refundedAt: '2026-10-10T00:00:00.000Z',
		})
		expect(readPurchaseDisputeLifecycle({ dispute: refunded })).toEqual({
			stripeDisputeId: 'du_1',
			state: 'won',
			refundedAt: '2026-10-10T00:00:00.000Z',
		})
	})
})

describe('readDisputeRecord', () => {
	it('reads the current shape and rejects anything else', () => {
		expect(readDisputeRecord({ dispute: record() })).toEqual(record())
		expect(
			readDisputeRecord({ dispute: { ...record(), state: 'paused' } }),
		).toBeUndefined()
		expect(
			readDisputeRecord({ dispute: { ...record(), originalStatus: 'Valid?' } }),
		).toBeUndefined()
		expect(readDisputeRecord(null)).toBeUndefined()
	})
})
