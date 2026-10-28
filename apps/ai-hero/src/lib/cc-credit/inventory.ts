import type { CreditReceipt } from './domain'
import { isCreditDescription } from './stripe'

export type CreditInventoryPreview = {
	state?: string
	reason?: string
	receipt?: CreditReceipt
	idempotent?: boolean
	remainingByPurchase?: Record<string, number>
}
export type HistoricalInvoice = {
	id: string
	customer: string | { id: string } | null
}
export type HistoricalLine = { description: string | null; amount: number }
export type InventoryInput = {
	mode: 'backfill_preview'
	scope: { stripeCustomerId: string }
	invoiceId: string
	seats: number
	audit: Record<string, string>
}

/** Read-only plan. Project all proposed active receipts against each purchase,
 * not just against the current DB, so two historical invoices cannot each
 * independently appear to own the same unseeded seats. Any hold blocks enablement.
 */
export async function inventoryCredits(
	deps: {
		invoices: AsyncIterable<HistoricalInvoice>
		lines: (invoiceId: string) => AsyncIterable<HistoricalLine>
		preview: (
			input: InventoryInput,
		) => Promise<{ ok: boolean; result: CreditInventoryPreview }>
	},
	runId: string,
) {
	const counts = {
		scannedInvoices: 0,
		matchedInvoices: 0,
		previewed: 0,
		alreadyLedgered: 0,
		held: 0,
		reserved: 0,
		paid: 0,
		released: 0,
	}
	const projected = new Map<string, number>()
	const records: {
		invoiceId: string
		state: string
		reason?: string
		receipt?: CreditReceipt
	}[] = []
	for await (const invoice of deps.invoices) {
		counts.scannedInvoices++
		const lines: HistoricalLine[] = []
		for await (const line of deps.lines(invoice.id))
			if (isCreditDescription(line.description)) lines.push(line)
		if (!lines.length) continue
		counts.matchedInvoices++
		const seats = lines
			.map((line) => /\bx\s*(\d+)\b/i.exec(line.description ?? '')?.[1])
			.map((value) => (value ? Number(value) : NaN))
		if (
			lines.some((line) => line.amount >= 0) ||
			seats.some((n) => !Number.isSafeInteger(n) || n < 1)
		) {
			counts.held++
			records.push({
				invoiceId: invoice.id,
				state: 'hold',
				reason: 'historical_credit_seat_count_or_amount_ambiguous',
			})
			continue
		}
		const customer =
			typeof invoice.customer === 'string'
				? invoice.customer
				: invoice.customer?.id
		const result = await deps.preview({
			mode: 'backfill_preview',
			scope: { stripeCustomerId: customer ?? '' },
			invoiceId: invoice.id,
			seats: seats.reduce((sum, n) => sum + n, 0),
			audit: {
				operatorId: 'cc-credit-backfill-dry-run',
				runId,
				approvalReference: 'inventory-only-no-writes',
			},
		})
		const body = result.result
		const receipt = body.receipt
		if (!result.ok || !receipt) {
			counts.held++
			records.push({
				invoiceId: invoice.id,
				state: 'hold',
				reason: body.reason ?? 'preview_unavailable',
			})
			continue
		}
		if (body.idempotent) {
			counts.alreadyLedgered++
			records.push({
				invoiceId: invoice.id,
				state: 'already_ledgered',
				receipt,
			})
			continue
		}
		if (
			receipt.status !== 'released' &&
			receipt.allocations.some(
				(a) =>
					a.seats + (projected.get(a.purchaseId) ?? 0) >
					(body.remainingByPurchase?.[a.purchaseId] ?? -1),
			)
		) {
			counts.held++
			records.push({
				invoiceId: invoice.id,
				state: 'hold',
				reason: 'historical_invoices_double_spend_same_purchase',
				receipt,
			})
			continue
		}
		if (receipt.status !== 'released')
			for (const a of receipt.allocations)
				projected.set(
					a.purchaseId,
					(projected.get(a.purchaseId) ?? 0) + a.seats,
				)
		counts.previewed++
		counts[receipt.status]++
		records.push({ invoiceId: invoice.id, state: 'preview', receipt })
	}
	return { counts, records }
}
