import {
	allocate,
	allocationTotal,
	creditBalance,
	CreditRefusal,
	PURCHASE_ID,
	positiveInteger,
	RECORDED_AMOUNT_TOLERANCE_CENTS,
	requestHash,
	settleStatus,
	type CreditAllocation,
	type ExplicitSource,
	type CreditReceipt,
	type CreditScope,
} from './domain'
import type { CreditStore } from './store'

export type InvoiceEvidence = {
	invoiceId: string
	stripeCustomerId: string
	status: string
	currency: string
	c5Seats: number
	c5AmountCents: number
	creditLines: { amountCents: number; description: string }[]
}
export type CreditCommand = {
	mode:
		| 'inspect'
		| 'reserve'
		| 'reconcile'
		| 'reconcile_preview'
		| 'backfill_preview'
		| 'backfill'
	scope: CreditScope
	invoice: InvoiceEvidence
	seats: number
	audit: Record<string, string>
	/** Backfill only: one desk-reviewed source per credit line, in line order. */
	sources?: ExplicitSource[]
}
const creditSum = (invoice: InvoiceEvidence) =>
	invoice.creditLines.reduce((sum, row) => sum - row.amountCents, 0)
const invoiceLinesFor = (allocations: CreditAllocation[]) =>
	allocations.map((row) => ({
		amountCents: -row.seats * row.perSeatCents,
		currency: 'usd' as const,
		discountable: false,
		description: `Crash Course team seat credit x ${row.seats} (${row.purchaseId}, $${(row.perSeatCents / 100).toFixed(2)} per seat)`,
	}))
function validateInvoice(
	invoice: InvoiceEvidence,
	scope: CreditScope,
	seats: number,
) {
	positiveInteger(seats, 'seats')
	if (invoice.stripeCustomerId !== scope.stripeCustomerId)
		throw new CreditRefusal('invoice_customer_mismatch')
	if (invoice.currency !== 'usd')
		throw new CreditRefusal('unsupported_invoice_currency')
	if (!Number.isSafeInteger(invoice.c5Seats) || invoice.c5Seats < seats)
		throw new CreditRefusal('not_enough_c5_invoice_seats')
	if (!Number.isSafeInteger(invoice.c5AmountCents) || invoice.c5AmountCents < 1)
		throw new CreditRefusal('invalid_c5_invoice_amount')
	if (
		invoice.creditLines.some(
			(line) =>
				!Number.isSafeInteger(line.amountCents) || line.amountCents >= 0,
		)
	)
		throw new CreditRefusal('invalid_credit_line')
}
function validateCredit(
	invoice: InvoiceEvidence,
	amount: number,
	requireLine: boolean,
) {
	if (amount > invoice.c5AmountCents)
		throw new CreditRefusal('credit_exceeds_c5_invoice_amount')
	if (
		(requireLine || invoice.creditLines.length > 0) &&
		creditSum(invoice) !== amount
	)
		throw new CreditRefusal('invoice_credit_amount_mismatch')
}
function checkReceipt(
	receipt: CreditReceipt,
	scope: CreditScope,
	seats: number,
) {
	if (receipt.requestHash !== requestHash(scope, seats))
		throw new CreditRefusal('invoice_id_reused_with_changed_request')
	if (
		receipt.seats !==
			receipt.allocations.reduce((n, row) => n + row.seats, 0) ||
		receipt.amountCents !== allocationTotal(receipt.allocations)
	)
		throw new CreditRefusal('ledger_receipt_inconsistent_hold_for_review')
}
/** A finalized Stripe line can't be edited to add its source, so the desk
 * states it. The line must agree on amount, seats and any id it names, and
 * the per-seat price may differ from the charge only by the recorded rounding.
 */
function explicitAllocation(
	line: InvoiceEvidence['creditLines'][number],
	ids: string[],
	given: ExplicitSource,
	sources: CreditAllocation[],
): CreditAllocation {
	const seats = positiveInteger(given.seats, 'explicit_source_seats')
	const perSeatCents = positiveInteger(
		given.perSeatCents,
		'explicit_per_seat_cents',
	)
	const declared = /credit x (\d+)\b/i.exec(line.description)?.[1]
	if (
		ids.length > 1 ||
		(ids.length === 1 && ids[0] !== given.purchaseId) ||
		(declared !== undefined && Number(declared) !== seats)
	)
		throw new CreditRefusal('explicit_source_contradicts_invoice_line')
	if (seats * perSeatCents !== -line.amountCents)
		throw new CreditRefusal('explicit_source_amount_mismatch')
	const row = sources.find((item) => item.purchaseId === given.purchaseId)
	if (!row) throw new CreditRefusal('historical_credit_source_ineligible')
	if (
		Math.abs(perSeatCents * row.purchaseSeats - row.purchaseTotalCents) >=
		RECORDED_AMOUNT_TOLERANCE_CENTS
	)
		throw new CreditRefusal('explicit_per_seat_cents_disagree_with_purchase')
	return { ...row, perSeatCents, seats }
}
/** Backfill preserves the recorded purchase/amount, never reallocates history.
 * Unknown purchase ids, fractional seats, duplicate source lines or missing ids
 * need review. A description without source evidence is not an empty ledger.
 */
function historicalAllocations(
	invoice: InvoiceEvidence,
	sources: CreditAllocation[],
	explicit?: ExplicitSource[],
): CreditAllocation[] {
	if (explicit && explicit.length !== invoice.creditLines.length)
		throw new CreditRefusal('explicit_sources_must_match_credit_lines')
	return invoice.creditLines.map((line, index) => {
		const ids = [...new Set(line.description.match(PURCHASE_ID) ?? [])]
		const given = explicit?.[index]
		if (given) return explicitAllocation(line, ids, given, sources)
		if (ids.length !== 1)
			throw new CreditRefusal('historical_credit_source_ambiguous')
		const row = sources.find((item) => item.purchaseId === ids[0])
		if (!row) throw new CreditRefusal('historical_credit_source_ineligible')
		const seats = positiveInteger(
			-line.amountCents / row.perSeatCents,
			'historical_credit_seats',
		)
		return { ...row, seats }
	})
}
export async function runCreditCommand(
	store: CreditStore,
	command: CreditCommand,
) {
	const { mode, invoice, scope, seats, audit, sources: explicit } = command
	validateInvoice(invoice, scope, seats)
	if (explicit && mode !== 'backfill_preview' && mode !== 'backfill')
		throw new CreditRefusal('explicit_sources_backfill_only')
	return store.locked(scope, invoice.invoiceId, async (tx) => {
		if (tx.receipt) {
			checkReceipt(tx.receipt, scope, seats)
			if (
				explicit &&
				(explicit.length !== tx.receipt.allocations.length ||
					explicit.some(
						(given) =>
							!tx.receipt!.allocations.some(
								(row) =>
									row.purchaseId === given.purchaseId &&
									row.seats === given.seats &&
									row.perSeatCents === given.perSeatCents,
							),
					))
			)
				throw new CreditRefusal('invoice_id_reused_with_changed_request')
			validateCredit(
				invoice,
				tx.receipt.amountCents,
				(mode === 'inspect' ||
					mode === 'reconcile' ||
					mode === 'reconcile_preview' ||
					mode === 'backfill') &&
					invoice.status !== 'void',
			)
			if (mode === 'inspect') {
				const actual = historicalAllocations(invoice, tx.receipt.allocations)
				const declaredSeats = invoice.creditLines.map((line) =>
					Number(/credit x (\d+)\b/i.exec(line.description)?.[1] ?? 0),
				)
				if (
					declaredSeats.some(
						(count, index) => count !== actual[index]?.seats,
					) ||
					actual.length !== tx.receipt.allocations.length ||
					new Set(actual.map((row) => row.purchaseId)).size !== actual.length ||
					actual.some(
						(row) =>
							!tx.receipt!.allocations.some(
								(expected) =>
									expected.purchaseId === row.purchaseId &&
									expected.seats === row.seats,
							),
					)
				)
					throw new CreditRefusal('invoice_credit_seat_count_mismatch')
			}
			if (
				mode === 'reconcile' ||
				mode === 'reconcile_preview' ||
				mode === 'backfill'
			) {
				const status = settleStatus(tx.receipt.status, invoice.status)
				if (mode === 'reconcile' || mode === 'backfill') await tx.settle(status)
				return {
					state: status,
					receipt: { ...tx.receipt, status },
					idempotent: status === tx.receipt.status,
				}
			}
			if (mode === 'backfill_preview')
				return {
					state: tx.receipt.status,
					receipt: tx.receipt,
					idempotent: true,
				}
			if (tx.receipt.status === 'released' || invoice.status === 'void')
				throw new CreditRefusal('invoice_released_or_void_use_new_invoice')
			return {
				state: tx.receipt.status,
				receipt: tx.receipt,
				idempotent: true,
				invoiceLines: invoiceLinesFor(tx.receipt.allocations),
			}
		}
		if (mode === 'reconcile' || mode === 'reconcile_preview')
			throw new CreditRefusal('reservation_missing_backfill_review_required')
		if (
			mode !== 'backfill_preview' &&
			mode !== 'backfill' &&
			invoice.status !== 'draft'
		)
			throw new CreditRefusal('reserve_before_invoice_finalization')
		if (
			(mode === 'backfill_preview' || mode === 'backfill') &&
			!['draft', 'open', 'paid', 'void', 'uncollectible'].includes(
				invoice.status,
			)
		)
			throw new CreditRefusal('unsupported_historical_invoice_status')
		let allocations: CreditAllocation[]
		if (mode === 'backfill_preview' || mode === 'backfill') {
			allocations = historicalAllocations(
				invoice,
				tx.sources.map((row) => ({ ...row, seats: 0 })),
				explicit,
			)
			if (
				!allocations.length ||
				new Set(allocations.map((a) => a.purchaseId)).size !==
					allocations.length
			)
				throw new CreditRefusal('historical_credit_lines_ambiguous')
			if (allocations.reduce((n, row) => n + row.seats, 0) !== seats)
				throw new CreditRefusal('historical_seat_count_mismatch')
			for (const row of allocations)
				if (
					row.seats + (tx.spent.get(row.purchaseId) ?? 0) > row.purchaseSeats &&
					invoice.status !== 'void'
				)
					throw new CreditRefusal('historical_credit_overdrawn')
		} else allocations = allocate(tx.sources, tx.spent, seats)
		const amountCents = allocationTotal(allocations)
		validateCredit(
			invoice,
			amountCents,
			mode === 'backfill_preview' || mode === 'backfill',
		)
		const receipt: CreditReceipt = {
			...scope,
			invoiceId: invoice.invoiceId,
			requestHash: requestHash(scope, seats),
			seats,
			amountCents,
			currency: invoice.currency,
			status:
				mode === 'backfill_preview' || mode === 'backfill'
					? invoice.status === 'paid'
						? 'paid'
						: invoice.status === 'void'
							? 'released'
							: 'reserved'
					: 'reserved',
			allocations,
		}
		if (mode === 'reserve' || mode === 'backfill')
			await tx.insert(receipt, audit)
		return {
			state:
				mode === 'reserve' || mode === 'backfill' ? receipt.status : 'preview',
			receipt,
			idempotent: false,
			remainingBefore: creditBalance(tx.sources, tx.spent),
			remainingByPurchase: Object.fromEntries(
				tx.sources.map((row) => [
					row.purchaseId,
					row.purchaseSeats - (tx.spent.get(row.purchaseId) ?? 0),
				]),
			),
			invoiceLines: invoiceLinesFor(allocations),
		}
	})
}
export const readCreditBalance = (store: CreditStore, scope: CreditScope) =>
	store.locked(scope, null, async (tx) => ({
		...creditBalance(tx.sources, tx.spent),
		currency: 'usd' as const,
	}))
