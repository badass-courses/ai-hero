import { beforeEach, describe, expect, it, vi } from 'vitest'

const tables = vi.hoisted(() => ({
	merchantCharge: { name: 'merchantCharge', id: 'merchantCharge.id' },
	purchases: {
		name: 'purchases',
		id: 'purchases.id',
		userId: 'purchases.userId',
		productId: 'purchases.productId',
		status: 'purchases.status',
		merchantChargeId: 'purchases.merchantChargeId',
	},
	purchaseUserTransfer: {
		name: 'purchaseUserTransfer',
		id: 'transfer.id',
		purchaseId: 'transfer.purchaseId',
		sourceUserId: 'transfer.sourceUserId',
		targetUserId: 'transfer.targetUserId',
		transferState: 'transfer.transferState',
	},
}))

const mocks = vi.hoisted(() => ({
	getTransfer: vi.fn(),
	getPurchase: vi.fn(),
	getUserById: vi.fn(),
	getEntitlements: vi.fn(),
	findTransfers: vi.fn(),
	findPurchases: vi.fn(),
	findCharge: vi.fn(),
	transaction: vi.fn(),
	recordOutbox: vi.fn(),
	publishOutbox: vi.fn(),
	getUnpublished: vi.fn(),
	stripeRetrieve: vi.fn(),
	inngestSend: vi.fn(),
	updates: [] as Array<{ table: unknown; values: unknown }>,
	evidence: new Map<string, unknown>(),
	tableExists: vi.fn(),
	recordSamePerson: vi.fn(),
	affected: vi.fn(),
	txs: [] as unknown[],
}))

vi.mock('@/db/schema', () => tables)
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getPurchaseUserTransferById: mocks.getTransfer,
		getPurchase: mocks.getPurchase,
		getUserById: mocks.getUserById,
		getEntitlementsForUser: mocks.getEntitlements,
	},
	db: {
		query: {
			purchaseUserTransfer: { findMany: mocks.findTransfers },
			purchases: { findMany: mocks.findPurchases },
			merchantCharge: { findFirst: mocks.findCharge },
		},
		transaction: mocks.transaction,
	},
}))
vi.mock('@/purchase-transfer/same-person', () => ({
	loadSamePersonFlags: async (ids: string[]) =>
		new Map(ids.flatMap((id) => (mocks.evidence.has(id) ? [[id, mocks.evidence.get(id)]] : []))),
	toTransferFacts: async (rows: Array<Record<string, unknown>>) =>
		rows.map((row) => ({
			id: row.id,
			state: row.transferState,
			sourceUserId: row.sourceUserId,
			targetUserId: row.targetUserId ?? null,
			completedAt: row.completedAt,
			createdAt: row.createdAt,
			samePerson: mocks.evidence.get(row.id as string) ?? null,
		})),
	samePersonTableExists: mocks.tableExists,
	recordSamePersonEvidence: mocks.recordSamePerson,
}))
vi.mock('@/env.mjs', () => ({
	env: { STRIPE_SECRET_TOKEN: 'test-stripe-secret' },
}))
vi.mock('@/purchase-transfer/transfer-outbox', () => ({
	recordTransferOutboxEvent: mocks.recordOutbox,
	publishTransferOutboxEvent: mocks.publishOutbox,
	getUnpublishedTransferOutboxEvents: mocks.getUnpublished,
}))
vi.mock('drizzle-orm', () => ({
	and: (...values: unknown[]) => values,
	eq: (...values: unknown[]) => values,
	inArray: (...values: unknown[]) => values,
	ne: (...values: unknown[]) => values,
}))
vi.mock('stripe', () => ({
	default: class Stripe {
		charges = { retrieve: mocks.stripeRetrieve }
	},
}))
vi.mock('inngest', () => ({
	Inngest: class Inngest {
		send = mocks.inngestSend
	},
}))
vi.mock('@coursebuilder/core/events/purchase-transfer', () => ({
	PURCHASE_TRANSFERRED_EVENT: 'commerce/purchase-transferred',
}))

import {
	completeSupportPurchaseTransfer,
	inspectSupportPurchaseTransferCompletion,
} from './support-complete'

const input = {
	transferId: 'transfer-1',
	purchaseId: 'purchase-1',
	sourceUserId: 'buyer-1',
	targetEmail: 'learner@example.com',
}
const transfer = {
	id: 'transfer-1',
	purchaseId: 'purchase-1',
	sourceUserId: 'buyer-1',
	targetUserId: 'learner-1',
	transferState: 'INITIATED',
}
const purchase = {
	id: 'purchase-1',
	userId: 'buyer-1',
	productId: 'product-1',
	status: 'Valid',
	merchantChargeId: 'charge-1',
	bulkCouponId: null,
	redeemedBulkCouponId: null,
}

function tx() {
	return {
		update(table: unknown) {
			return {
				set(values: unknown) {
					mocks.updates.push({ table, values })
					return {
						where: vi.fn(async () => ({ rowsAffected: mocks.affected(table) })),
					}
				},
			}
		},
	}
}

describe('guarded support purchase completion', () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mocks.updates.length = 0
		mocks.evidence.clear()
		mocks.txs.length = 0
		mocks.affected.mockReturnValue(1)
		mocks.tableExists.mockResolvedValue(true)
		mocks.recordSamePerson.mockResolvedValue(undefined)
		process.env.INNGEST_EVENT_KEY = 'test-event-key'
		mocks.getTransfer.mockResolvedValue(transfer)
		mocks.getPurchase.mockResolvedValue(purchase)
		mocks.getUserById.mockImplementation(async (id: string) =>
			id === 'buyer-1'
				? { id, email: 'buyer@example.com' }
				: { id, email: 'learner@example.com' },
		)
		mocks.getEntitlements.mockResolvedValue([])
		mocks.findTransfers.mockResolvedValue([])
		mocks.findPurchases.mockResolvedValue([])
		mocks.findCharge.mockResolvedValue({
			id: 'charge-1',
			identifier: 'ch_test',
			userId: 'buyer-1',
		})
		mocks.stripeRetrieve.mockResolvedValue({
			refunded: false,
			amount_refunded: 0,
			refunds: { data: [] },
		})
		mocks.transaction.mockImplementation(async (run: (value: ReturnType<typeof tx>) => unknown) => {
			const value = tx()
			mocks.txs.push(value)
			return run(value)
		})
		mocks.recordOutbox.mockResolvedValue('outbox-1')
		mocks.publishOutbox.mockResolvedValue({ published: true })
	})

	it('moves access ownership, preserves payer billing ownership, and dispatches the verified workflow', async () => {
		await expect(completeSupportPurchaseTransfer(input)).resolves.toEqual({
			state: 'completion_requested',
			transferId: 'transfer-1',
		})
		expect(mocks.updates).toEqual([
			{ table: tables.purchaseUserTransfer, values: expect.objectContaining({ transferState: 'VERIFIED' }) },
			{ table: tables.purchases, values: { userId: 'learner-1' } },
		])
		expect(mocks.updates.some((entry) => entry.table === tables.merchantCharge)).toBe(false)
		expect(mocks.findCharge).toHaveBeenCalledTimes(2)
		expect(mocks.recordOutbox).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				purchaseId: 'purchase-1',
				sourceUserId: 'buyer-1',
				targetUserId: 'learner-1',
			}),
		)
		expect(mocks.publishOutbox).toHaveBeenCalledWith(
			expect.objectContaining({ outboxId: 'outbox-1' }),
		)
	})

	it('same-person moves are refused before any write', async () => {
		mocks.getTransfer.mockResolvedValue({ ...transfer, targetUserId: 'buyer-1' })
		mocks.getUserById.mockImplementation(async (id: string) => ({
			id,
			email: 'learner@example.com',
		}))
		await expect(completeSupportPurchaseTransfer(input)).resolves.toEqual({
			state: 'blocked',
			reason: 'same_user_transfer',
		})
		expect(mocks.transaction).not.toHaveBeenCalled()
		expect(mocks.updates).toHaveLength(0)
	})

	it('never moves the purchase without claiming its own transfer row in the same transaction', async () => {
		await completeSupportPurchaseTransfer(input)
		const tables_ = mocks.updates.map((entry) => entry.table)
		expect(tables_).toEqual([tables.purchaseUserTransfer, tables.purchases])
		expect(mocks.transaction).toHaveBeenCalledTimes(1)
	})

	const earlier = (sourceUserId: string) => ({
		id: 'transfer-0',
		transferState: 'COMPLETED',
		sourceUserId,
		completedAt: new Date('2026-09-01T00:00:00.000Z'),
		createdAt: new Date('2026-09-01T00:00:00.000Z'),
	})
	const holderIsB = {
		input: { ...input, sourceUserId: 'holder-b' },
		purchase: { ...purchase, userId: 'holder-b' },
		transfer: { ...transfer, sourceUserId: 'holder-b' },
	}

	it('moves a purchase the payer already transferred away (post-fix A to B, then B to C), payer stays A', async () => {
		mocks.getTransfer.mockResolvedValue(holderIsB.transfer)
		mocks.getPurchase.mockResolvedValue(holderIsB.purchase)
		// The charge stays with the payer, not the holder moving it.
		// findTransfers is called twice, in this order: open conflicts first,
		// then the other COMPLETED rows for the payer.
		mocks.findTransfers
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([earlier('buyer-1')])
		await expect(
			completeSupportPurchaseTransfer(holderIsB.input),
		).resolves.toMatchObject({ state: 'completion_requested' })
		expect(mocks.updates.map((entry) => entry.table)).toEqual([
			tables.purchaseUserTransfer,
			tables.purchases,
		])
	})

	it('moves a pre-fix transferred purchase (charge rewritten to the holder), payer resolves to the origin', async () => {
		mocks.getTransfer.mockResolvedValue(holderIsB.transfer)
		mocks.getPurchase.mockResolvedValue(holderIsB.purchase)
		mocks.findCharge.mockResolvedValue({
			id: 'charge-1',
			identifier: 'ch_test',
			userId: 'holder-b',
		})
		mocks.findTransfers
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([earlier('buyer-1')])
		await expect(
			completeSupportPurchaseTransfer(holderIsB.input),
		).resolves.toMatchObject({ state: 'completion_requested' })
	})

	it('refuses a move by someone who does not hold the purchase', async () => {
		mocks.getPurchase.mockResolvedValue({ ...purchase, userId: 'someone-else' })
		await expect(completeSupportPurchaseTransfer(input)).resolves.toEqual({
			state: 'blocked',
			reason: 'source_no_longer_owns_purchase',
		})
		expect(mocks.transaction).not.toHaveBeenCalled()
	})

	it('refuses a move when the purchase points at a charge row that does not exist', async () => {
		mocks.findCharge.mockResolvedValue(null)
		await expect(completeSupportPurchaseTransfer(input)).resolves.toEqual({
			state: 'blocked',
			reason: 'billing_charge_missing',
		})
		expect(mocks.transaction).not.toHaveBeenCalled()
	})

	it('refuses a move that would leave the charge with no payer (defense in depth: the column is NOT NULL)', async () => {
		mocks.findCharge.mockResolvedValue({
			id: 'charge-1',
			identifier: 'ch_test',
			userId: null,
		})
		await expect(completeSupportPurchaseTransfer(input)).resolves.toEqual({
			state: 'blocked',
			reason: 'move_would_leave_charge_without_payer',
		})
		expect(mocks.transaction).not.toHaveBeenCalled()
	})

	it('refuses a move that would change who the payer is (holder changed without a completed row)', async () => {
		// The charge names the payer, the purchase is held by someone else, and
		// no completed transfer explains it: moving it would name the holder.
		mocks.getTransfer.mockResolvedValue(holderIsB.transfer)
		mocks.getPurchase.mockResolvedValue(holderIsB.purchase)
		await expect(
			completeSupportPurchaseTransfer(holderIsB.input),
		).resolves.toEqual({
			state: 'blocked',
			reason: 'move_would_change_invoice_payer',
		})
		expect(mocks.transaction).not.toHaveBeenCalled()
	})

	it('fails closed for team purchases before any mutation', async () => {
		mocks.getPurchase.mockResolvedValue({ ...purchase, bulkCouponId: 'coupon-team' })
		await expect(completeSupportPurchaseTransfer(input)).resolves.toEqual({
			state: 'blocked',
			reason: 'team_purchase_not_supported',
		})
		expect(mocks.transaction).not.toHaveBeenCalled()
	})

	it('fails closed when Stripe shows any refund', async () => {
		mocks.stripeRetrieve.mockResolvedValue({
			refunded: false,
			amount_refunded: 100,
			refunds: { data: [{ status: 'succeeded' }] },
		})
		await expect(completeSupportPurchaseTransfer(input)).resolves.toEqual({
			state: 'blocked',
			reason: 'refund_present',
		})
		expect(mocks.transaction).not.toHaveBeenCalled()
	})

	describe('same-person move', () => {
		const samePerson = {
			verifiedBy: 'owner-mailbox-both' as const,
			reason: 'Support confirmed both mailboxes',
			proofRef: 'proof-ref-1',
		}
		const withFlag = { ...input, samePerson }

		it('records the evidence in the VERIFIED claim transaction and leaves Stripe and the charge alone', async () => {
			await expect(completeSupportPurchaseTransfer(withFlag)).resolves.toMatchObject({
				state: 'completion_requested',
			})
			expect(mocks.recordSamePerson).toHaveBeenCalledTimes(1)
			expect(mocks.recordSamePerson).toHaveBeenCalledWith(
				expect.anything(),
				'transfer-1',
				samePerson,
			)
			expect(mocks.transaction).toHaveBeenCalledTimes(1)
			expect(mocks.updates.some((entry) => entry.table === tables.merchantCharge)).toBe(false)
		})

		it('a normal move records no evidence', async () => {
			await completeSupportPurchaseTransfer(input)
			expect(mocks.recordSamePerson).not.toHaveBeenCalled()
		})

		it.each([
			['no verifiedBy', { reason: 'r', proofRef: 'p' }],
			['unknown verifiedBy', { verifiedBy: 'matching-emails', reason: 'r', proofRef: 'p' }],
			['blank reason', { verifiedBy: 'owner-mailbox-both', reason: '  ', proofRef: 'p' }],
			['blank proofRef', { verifiedBy: 'same-stripe-customer', reason: 'r', proofRef: '' }],
			['null', null],
		])('refuses evidence with %s before any write', async (_name, bad) => {
			await expect(
				completeSupportPurchaseTransfer({ ...input, samePerson: bad as never }),
			).resolves.toEqual({ state: 'blocked', reason: 'same_person_evidence_invalid' })
			expect(mocks.transaction).not.toHaveBeenCalled()
			expect(mocks.recordSamePerson).not.toHaveBeenCalled()
		})

		it('refuses, and completes nothing, when the same-person table is missing', async () => {
			mocks.tableExists.mockResolvedValue(false)
			await expect(completeSupportPurchaseTransfer(withFlag)).resolves.toEqual({
				state: 'blocked',
				reason: 'same_person_table_missing',
			})
			expect(mocks.transaction).not.toHaveBeenCalled()
			expect(mocks.updates).toHaveLength(0)
		})

		it('a normal move still works when the table is missing', async () => {
			mocks.tableExists.mockResolvedValue(false)
			await expect(completeSupportPurchaseTransfer(input)).resolves.toMatchObject({
				state: 'completion_requested',
			})
		})

		it('writes the evidence in the claim transaction, after both conditional updates', async () => {
			await completeSupportPurchaseTransfer(withFlag)
			expect(mocks.txs).toHaveLength(1)
			expect(mocks.recordSamePerson.mock.calls[0]?.[0]).toBe(mocks.txs[0])
			// The claim is conditional on INITIATED and the purchase move on the
			// source still holding it (both asserted on rowsAffected below);
			// the evidence is written only once both have succeeded.
			expect(mocks.updates.map((entry) => entry.table)).toEqual([
				tables.purchaseUserTransfer,
				tables.purchases,
			])
		})

		it.each([
			['the claim', tables.purchaseUserTransfer, 'transfer_claim_race'],
			['the purchase move', tables.purchases, 'purchase_owner_race'],
		])('a lost race on %s throws and leaves no evidence row', async (_name, table, message) => {
			mocks.affected.mockImplementation((t: unknown) => (t === table ? 0 : 1))
			await expect(completeSupportPurchaseTransfer(withFlag)).rejects.toThrow(message)
			expect(mocks.recordSamePerson).not.toHaveBeenCalled()
			expect(mocks.recordOutbox).not.toHaveBeenCalled()
			expect(mocks.publishOutbox).not.toHaveBeenCalled()
		})

		it('refuses with same_person_order_unknown when an earlier completed transfer has no date', async () => {
			mocks.findTransfers
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([
					{ id: 'transfer-0', transferState: 'COMPLETED', sourceUserId: 'buyer-1' },
				])
			await expect(completeSupportPurchaseTransfer(withFlag)).resolves.toEqual({
				state: 'blocked',
				reason: 'same_person_order_unknown',
			})
			expect(mocks.transaction).not.toHaveBeenCalled()
		})

		it('a plain move over undated history is unchanged by the same-person rule', async () => {
			mocks.findTransfers
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([
					{ id: 'transfer-0', transferState: 'COMPLETED', sourceUserId: 'buyer-1' },
				])
			await expect(completeSupportPurchaseTransfer(input)).resolves.toMatchObject({
				state: 'completion_requested',
			})
		})

		describe('resume after the claim: the recorded row is authoritative', () => {
			const verified = { ...transfer, transferState: 'VERIFIED' }
			const arrange = () => {
				mocks.getTransfer.mockResolvedValue(verified)
				mocks.getPurchase.mockResolvedValue({ ...purchase, userId: 'learner-1' })
				mocks.getUnpublished.mockResolvedValue([{ id: 'outbox-1' }])
				mocks.evidence.set('transfer-1', { verifiedBy: 'owner-mailbox-both' })
			}
			it('resumes with samePerson: continues, and does not write the evidence again', async () => {
				arrange()
				await expect(completeSupportPurchaseTransfer(withFlag)).resolves.toMatchObject({
					state: 'completion_requested',
				})
				expect(mocks.transaction).not.toHaveBeenCalled()
				expect(mocks.recordSamePerson).not.toHaveBeenCalled()
			})
			it('resumes without samePerson: continues, and the recorded row stands', async () => {
				arrange()
				await expect(completeSupportPurchaseTransfer(input)).resolves.toMatchObject({
					state: 'completion_requested',
				})
				expect(mocks.recordSamePerson).not.toHaveBeenCalled()
			})
			it('resumes with different evidence than recorded: the request evidence is ignored, not rewritten', async () => {
				arrange()
				await expect(
					completeSupportPurchaseTransfer({
						...input,
						samePerson: { ...samePerson, verifiedBy: 'same-stripe-customer' },
					}),
				).resolves.toMatchObject({ state: 'completion_requested' })
				expect(mocks.recordSamePerson).not.toHaveBeenCalled()
			})
		})

		describe('emails are never evidence', () => {
			// A mutant that sets the flag when the normalized emails match.
			const normalize = (email: string) =>
				email.trim().toLowerCase().replace(/\+[^@]*@/, '@')
			const mutantInfersFlag = (source: string, target: string) =>
				normalize(source) === normalize(target)
					? { verifiedBy: 'owner-mailbox-both' as const }
					: undefined
			const cases = [
				['identical', 'learner@example.com', 'learner@example.com'],
				['case-different', 'Learner@Example.com', 'learner@example.com'],
				['plus-address', 'learner+old@example.com', 'learner@example.com'],
			] as const

			it.each(cases)('%s emails, no samePerson: no evidence row and the payer is unchanged', async (_name, sourceEmail, targetEmail) => {
				mocks.getUserById.mockImplementation(async (id: string) =>
					id === 'buyer-1'
						? { id, email: sourceEmail }
						: { id, email: targetEmail },
				)
				await expect(
					completeSupportPurchaseTransfer({ ...input, targetEmail }),
				).resolves.toMatchObject({ state: 'completion_requested' })
				expect(mocks.recordSamePerson).not.toHaveBeenCalled()
				expect(mocks.tableExists).not.toHaveBeenCalled()
				// The guard ran the plain-move rule: a move that changed the
				// payer would have been refused before any write.
				expect(mocks.updates.some((entry) => entry.table === tables.merchantCharge)).toBe(false)
			})

			it('the mutant would have inferred a flag for every one of these cases', () => {
				for (const [, a, b] of cases) expect(mutantInfersFlag(a, b)).toBeDefined()
				expect(mutantInfersFlag('a@example.com', 'b@example.com')).toBeUndefined()
			})
		})

		it('a dry run and a real run agree on same_person_source_not_payer', async () => {
			mocks.getTransfer.mockResolvedValue(holderIsB.transfer)
			mocks.getPurchase.mockResolvedValue(holderIsB.purchase)
			const history = [earlier('buyer-1')]
			mocks.findTransfers
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce(history)
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce(history)
			const body = { ...holderIsB.input, samePerson }
			const dry = await inspectSupportPurchaseTransferCompletion(body)
			const real = await completeSupportPurchaseTransfer(body)
			expect(dry).toEqual({ state: 'blocked', reason: 'same_person_source_not_payer' })
			expect(real).toEqual(dry)
		})

		it('a dry run passes the same evidence through the same guard: ready when the real run would proceed', async () => {
			await expect(inspectSupportPurchaseTransferCompletion(withFlag)).resolves.toEqual({
				state: 'ready',
				transferId: 'transfer-1',
			})
			mocks.tableExists.mockResolvedValue(false)
			await expect(inspectSupportPurchaseTransferCompletion(withFlag)).resolves.toEqual({
				state: 'blocked',
				reason: 'same_person_table_missing',
			})
			expect(mocks.transaction).not.toHaveBeenCalled()
		})

		it('refuses a same-person move by a holder who never paid', async () => {
			mocks.getTransfer.mockResolvedValue(holderIsB.transfer)
			mocks.getPurchase.mockResolvedValue(holderIsB.purchase)
			mocks.findTransfers
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([earlier('buyer-1')])
			await expect(
				completeSupportPurchaseTransfer({ ...holderIsB.input, samePerson }),
			).resolves.toEqual({ state: 'blocked', reason: 'same_person_source_not_payer' })
			expect(mocks.transaction).not.toHaveBeenCalled()
		})

		it('lets the new payer move on again: A to A-prime (same person), then A-prime to B, is a normal move', async () => {
			mocks.evidence.set('transfer-0', { verifiedBy: samePerson.verifiedBy })
			const aPrime = {
				input: { ...input, sourceUserId: 'learner-1', targetEmail: 'b@example.com' },
				purchase: { ...purchase, userId: 'learner-1' },
				transfer: { ...transfer, sourceUserId: 'learner-1', targetUserId: 'learner-2' },
			}
			mocks.getTransfer.mockResolvedValue(aPrime.transfer)
			mocks.getPurchase.mockResolvedValue(aPrime.purchase)
			mocks.getUserById.mockImplementation(async (id: string) => ({
				id,
				email: id === 'learner-2' ? 'b@example.com' : 'x@example.com',
			}))
			mocks.findTransfers
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([{ ...earlier('buyer-1'), targetUserId: 'learner-1' }])
			await expect(
				completeSupportPurchaseTransfer(aPrime.input),
			).resolves.toMatchObject({ state: 'completion_requested' })
		})

		it('a flag cannot be added to a transfer past its claim unless already recorded', async () => {
			mocks.getTransfer.mockResolvedValue({ ...transfer, transferState: 'VERIFIED' })
			mocks.getPurchase.mockResolvedValue({ ...purchase, userId: 'learner-1' })
			await expect(completeSupportPurchaseTransfer(withFlag)).resolves.toEqual({
				state: 'blocked',
				reason: 'same_person_cannot_be_added_after_claim',
			})
		})
	})
})
