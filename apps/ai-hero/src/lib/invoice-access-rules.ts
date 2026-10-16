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
 * buyer's charges. */

export type InvoiceTransferFact = {
	id?: string
	// PurchaseUserTransfer.transferState; only COMPLETED moved ownership.
	state: string
	sourceUserId: string
	completedAt?: Date | null
	createdAt?: Date | null
}

/**
 * Picks the transfer that started the chain: the earliest COMPLETED one.
 * Its source is the original payer. Later hops (A to B to C) name B as a
 * source, but B only held the purchase and never paid.
 */
export function pickOriginTransfer(
	transfers: InvoiceTransferFact[],
): InvoiceTransferFact | null {
	const completed = transfers.filter(
		(transfer) => transfer.state === 'COMPLETED',
	)
	if (completed.length === 0) return null
	// completedAt, then createdAt, then id. Without any timestamp the order
	// is unknowable, so name no origin rather than guess.
	const stamp = (transfer: InvoiceTransferFact) =>
		(transfer.completedAt ?? transfer.createdAt)?.getTime()
	if (completed.some((transfer) => stamp(transfer) === undefined)) return null
	return completed.reduce((first, next) => {
		const a = stamp(next)!
		const b = stamp(first)!
		if (a !== b) return a < b ? next : first
		return (next.id ?? '') < (first.id ?? '') ? next : first
	})
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
 * The payer of a charge: the source of the earliest completed transfer, else
 * `MerchantCharge.userId`. Null when neither names anyone.
 */
export function resolveInvoicePayer({
	chargeUserId,
	transfers,
}: {
	chargeUserId: string | null | undefined
	transfers: InvoiceTransferFact[]
}): string | null {
	return pickOriginTransfer(transfers)?.sourceUserId ?? chargeUserId ?? null
}

/**
 * Who may edit an invoice: the payer, and nobody else. The current holder
 * (when not the payer) views only.
 *
 * The payer is the source of the earliest completed transfer, the same rule
 * `canViewInvoice` uses, else `payerUserId` (`MerchantCharge.userId`). That
 * keeps purchases transferred before the payer fix correct: their
 * `MerchantCharge.userId` names the holder.
 */
export function canEditInvoice({
	viewerId,
	payerUserId,
	holderUserId,
	transfer,
}: {
	viewerId: string | null | undefined
	payerUserId: string | null | undefined
	holderUserId: string | null | undefined
	transfer: InvoiceTransferFact | null
}): boolean {
	if (!viewerId) return false
	// One rule surface: `resolveInvoicePayer` decides, so an undated COMPLETED
	// transfer is ignored here exactly as it is there. The holder needs no
	// guard of its own: a holder who is not the payer is not the payer.
	const payer = resolveInvoicePayer({
		chargeUserId: payerUserId,
		transfers: transfer ? [transfer] : [],
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
