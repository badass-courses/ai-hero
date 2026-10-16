import { getInvoicePresentment } from '@/lib/invoice-amounts'

/**
 * Pure decisions behind the invoice list and invoice page.
 *
 * A completed purchase transfer moves `Purchase.userId` and also reassigns
 * `MerchantCharge.userId` to the new holder, so the charge alone no longer
 * names the person who paid. The first completed `PurchaseUserTransfer` row
 * keeps that person as its `sourceUserId`.
 */

export type InvoiceTransferFact = {
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
	const at = (transfer: InvoiceTransferFact) =>
		(transfer.completedAt ?? transfer.createdAt)?.getTime() ?? 0
	return completed.reduce((first, next) =>
		at(next) < at(first) ? next : first,
	)
}

/** The paying account: the origin transfer's source, else the charge owner. */
export function resolveOriginalPayerUserId(
	chargeUserId: string | null | undefined,
	transfers: InvoiceTransferFact[],
): string | null {
	return pickOriginTransfer(transfers)?.sourceUserId ?? chargeUserId ?? null
}

/**
 * Who may see an invoice: the person who paid, and whoever holds the
 * purchase now. Previous holders who did not pay, and everyone else, may not.
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
}

export type InvoiceListEntry<Row extends InvoiceListRow> = {
	row: Row
	merchantChargeId: string
	refunded: boolean
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
					? 'None of your purchases have an invoice. Complimentary and redeemed purchases are not billed, so there is nothing to invoice.'
					: 'You have no invoices yet.',
	}
}
