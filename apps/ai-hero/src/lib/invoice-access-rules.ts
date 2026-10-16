import { getInvoicePresentment } from '@/lib/invoice-amounts'

/**
 * Pure decisions behind the invoice list and invoice page.
 *
 * Two transfer shapes coexist. Before the payer fix, a self-service transfer
 * also rewrote `MerchantCharge.userId` and `MerchantCustomer.userId` to the new
 * holder, so the first completed `PurchaseUserTransfer` row's `sourceUserId`
 * was the only record of who paid. Since the fix, a transfer moves
 * `Purchase.userId` only and `MerchantCharge.userId` keeps naming the payer.
 * Support-complete always moved only `Purchase.userId`.
 * The payer is therefore the earliest completed transfer's source when there
 * is one, otherwise `MerchantCharge.userId`. Both shapes give the same answer.
 * `MerchantCustomer` is deliberately not used: one customer is shared across a
 * buyer's charges.
 *
 * One exception moves the payer: a support-completed transfer recorded with
 * same-person evidence (`PurchaseTransferSamePerson`). Support verified that
 * both accounts belong to one person, so the new account becomes the payer.
 * See `resolveInvoicePayer`. Nothing infers it; no flag, no move. */

export const SAME_PERSON_VERIFIED_BY = [
	'owner-mailbox-both',
	'same-stripe-customer',
] as const

export const SAME_PERSON_LIMITS = { reason: 1000, proofRef: 255 } as const

export type SamePersonKind = (typeof SAME_PERSON_VERIFIED_BY)[number]

/** What support sends and the writer stores. Readers never see it. */
export type SamePersonEvidence = {
	verifiedBy: SamePersonKind
	reason: string
	proofRef: string
}

/**
 * What a reader gets: only that evidence exists and which kind. `reason` and
 * `proofRef` stay with the writer and never travel in a transfer fact.
 */
export type SamePersonFlag = { verifiedBy: SamePersonKind }

export type InvoiceTransferFact = {
	id?: string
	// PurchaseUserTransfer.transferState; only COMPLETED moved ownership.
	state: string
	sourceUserId: string
	targetUserId?: string | null
	completedAt?: Date | null
	createdAt?: Date | null
	// Set only when valid same-person evidence is recorded for this transfer.
	// Only support-complete writes it.
	samePerson?: SamePersonFlag | null
}

export function isSamePersonKind(value: unknown): value is SamePersonKind {
	return (
		typeof value === 'string' &&
		(SAME_PERSON_VERIFIED_BY as readonly string[]).includes(value)
	)
}

function isSamePersonFlag(value: unknown): value is SamePersonFlag {
	return (
		!!value &&
		typeof value === 'object' &&
		isSamePersonKind((value as { verifiedBy?: unknown }).verifiedBy)
	)
}

/**
 * Evidence counts only when it names a known verification kind and carries a
 * non-blank reason (at most 1000 characters) and proof reference (at most 255,
 * and no `@`, so no email lands in a durable column). Lengths are of the
 * trimmed value. A flag without evidence is no flag.
 */
export function isValidSamePersonEvidence(
	evidence: unknown,
): evidence is SamePersonEvidence {
	if (!evidence || typeof evidence !== 'object') return false
	const { verifiedBy, reason, proofRef } = evidence as Record<string, unknown>
	if (!isSamePersonKind(verifiedBy)) return false
	if (typeof reason !== 'string' || typeof proofRef !== 'string') return false
	const trimmedReason = reason.trim()
	const trimmedProof = proofRef.trim()
	return (
		trimmedReason.length > 0 &&
		trimmedReason.length <= SAME_PERSON_LIMITS.reason &&
		trimmedProof.length > 0 &&
		trimmedProof.length <= SAME_PERSON_LIMITS.proofRef &&
		!trimmedProof.includes('@')
	)
}

/**
 * The COMPLETED transfers oldest first (`completedAt`, else `createdAt`, then
 * id), or null when any has no timestamp: the order is then unknowable. The
 * one ordering `pickOriginTransfer` and `resolveInvoicePayer` both use.
 */
export function orderCompletedTransfers(
	transfers: InvoiceTransferFact[],
): InvoiceTransferFact[] | null {
	const completed = transfers.filter(
		(transfer) => transfer.state === 'COMPLETED',
	)
	const stamp = (transfer: InvoiceTransferFact) =>
		(transfer.completedAt ?? transfer.createdAt)?.getTime()
	if (completed.some((transfer) => stamp(transfer) === undefined)) return null
	return completed.sort((a, b) => {
		const delta = stamp(a)! - stamp(b)!
		if (delta !== 0) return delta
		return (a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0
	})
}

/**
 * Picks the transfer that started the chain: the earliest COMPLETED one.
 * Its source is the original payer. Later hops (A to B to C) name B as a
 * source, but B only held the purchase and never paid. Without any
 * timestamp the order is unknowable, so name no origin rather than guess.
 */
export function pickOriginTransfer(
	transfers: InvoiceTransferFact[],
): InvoiceTransferFact | null {
	return orderCompletedTransfers(transfers)?.[0] ?? null
}

/**
 * Who may see an invoice: the person who paid, and whoever holds the
 * purchase now. `payerUserId` is `MerchantCharge.userId`. Previous holders who
 * did not pay, and everyone else, may not.
 * `transfer` is the origin transfer from `pickOriginTransfer`, if any.
 */
export function canViewInvoice({
	viewerId,
	purchaseUserId,
	payerUserId,
	transfer,
}: {
	viewerId: string | null | undefined
	purchaseUserId: string | null | undefined
	payerUserId: string | null | undefined
	transfer: Pick<InvoiceTransferFact, 'state' | 'sourceUserId'> | null
}): boolean {
	if (!viewerId) return false
	if (viewerId === purchaseUserId) return true
	if (viewerId === payerUserId) return true
	return Boolean(
		transfer &&
		transfer.state === 'COMPLETED' &&
		transfer.sourceUserId === viewerId,
	)
}

/**
 * The payer of a charge.
 *
 * Start from the #439 rule: the source of the earliest completed transfer,
 * else `MerchantCharge.userId`. Then walk the completed transfers oldest
 * first. A transfer with a same-person flag whose source is the current payer
 * moves the payer to its target. Every other transfer, flagged or not, leaves
 * the payer alone: a same-person hop by someone who never paid (A to B, then
 * B to B') does not follow the payer chain.
 *
 * With any undated completed transfer the order is unknowable, so no
 * same-person move applies, exactly as no origin is named. Null when nothing
 * names anyone.
 */
export function resolveInvoicePayer({
	chargeUserId,
	transfers,
}: {
	chargeUserId: string | null | undefined
	transfers: InvoiceTransferFact[]
}): string | null {
	let payer = pickOriginTransfer(transfers)?.sourceUserId ?? chargeUserId ?? null
	if (!payer) return null
	for (const transfer of orderCompletedTransfers(transfers) ?? []) {
		if (
			isSamePersonFlag(transfer.samePerson) &&
			transfer.targetUserId &&
			transfer.sourceUserId === payer
		) {
			payer = transfer.targetUserId
		}
	}
	return payer
}

/**
 * Who may edit an invoice: the payer, and nobody else. The current holder
 * (when not the payer) views only.
 *
 * The payer comes from `resolveInvoicePayer` over every completed transfer,
 * else `payerUserId` (`MerchantCharge.userId`). That
 * keeps purchases transferred before the payer fix correct: their
 * `MerchantCharge.userId` names the holder.
 */
export function canEditInvoice({
	viewerId,
	payerUserId,
	transfers,
}: {
	viewerId: string | null | undefined
	payerUserId: string | null | undefined
	holderUserId: string | null | undefined
	transfers: InvoiceTransferFact[]
}): boolean {
	if (!viewerId) return false
	// One rule surface: `resolveInvoicePayer` decides, so an undated COMPLETED
	// transfer is ignored here exactly as it is there. `holderUserId` is part
	// of the signature so callers state who holds the purchase, but the rule
	// does not read it: a holder who is not the payer is not the payer.
	const payer = resolveInvoicePayer({
		chargeUserId: payerUserId,
		transfers,
	})
	return viewerId === payer
}

export type InvoiceChargeFacts = {
	amount: number
	currency: string
	amount_refunded: number
	presentment_details?: unknown
}

export type InvoiceDisplayAmount = {
	// What the buyer was charged: local currency when the charge has it.
	primary: { amount: number; currency: string }
	// Settlement amount after refunds, only when it differs from primary.
	secondary: { amount: number; currency: string } | null
}

/**
 * Amounts come from the stored Stripe charge only, never price times rate.
 * With valid presentment details the buyer's currency leads and the
 * settlement currency is the secondary line. Otherwise the charge is shown.
 */
export function invoiceDisplayAmount(
	facts: InvoiceChargeFacts,
): InvoiceDisplayAmount {
	const received = facts.amount - facts.amount_refunded
	const presentment = getInvoicePresentment({
		currency: facts.currency,
		presentment_details: facts.presentment_details,
	})
	if (!presentment) {
		return {
			primary: { amount: received, currency: facts.currency.toUpperCase() },
			secondary: null,
		}
	}
	return {
		primary: presentment,
		secondary: { amount: received, currency: facts.currency.toUpperCase() },
	}
}

export type InvoiceListRow = {
	merchantChargeId?: string | null
	status?: string | null
	// True only for the billing owner. Holders who did not pay view only.
	canEdit?: boolean
}

export type InvoiceListEntry<Row extends InvoiceListRow> = {
	row: Row
	merchantChargeId: string
	refunded: boolean
	canEdit: boolean
}

export type InvoiceListView<Row extends InvoiceListRow> = {
	heading: 'Your Invoices' | 'No invoices'
	entries: InvoiceListEntry<Row>[]
	// Rows with no merchant charge: comp or redemption purchases.
	withoutInvoiceCount: number
	emptyMessage: string | null
}

/**
 * Only rows with a merchant charge have an invoice. The heading and empty
 * state follow the invoices actually listed, not the purchase count.
 */
export function invoiceListView<Row extends InvoiceListRow>(
	rows: Row[],
): InvoiceListView<Row> {
	const entries: InvoiceListEntry<Row>[] = []
	for (const row of rows) {
		if (!row.merchantChargeId) continue
		entries.push({
			row,
			merchantChargeId: row.merchantChargeId,
			refunded: row.status === 'Refunded',
			canEdit: row.canEdit === true,
		})
	}
	const withoutInvoiceCount = rows.length - entries.length
	return {
		heading: entries.length > 0 ? 'Your Invoices' : 'No invoices',
		entries,
		withoutInvoiceCount,
		emptyMessage:
			entries.length > 0
				? null
				: withoutInvoiceCount > 0
					? "These purchases were free or paid for by someone else, so there's no invoice for you here."
					: 'You have no invoices yet.',
	}
}
