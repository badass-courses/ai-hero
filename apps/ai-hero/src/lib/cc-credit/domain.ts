import { createHash } from 'node:crypto'

export const CC_PRODUCT = 'product-ma254'
export const C5_PRODUCT = 'product-s00zs'
export type CreditStatus = 'reserved' | 'paid' | 'released'
export type CreditScope = { stripeCustomerId: string; organizationId?: string }
export type CreditSource = {
	purchaseId: string
	purchaseSeats: number
	purchaseTotalCents: number
	perSeatCents: number
}
export type CreditAllocation = CreditSource & { seats: number }
/** Desk-reviewed source for one historical credit line, in line order. */
export type ExplicitSource = {
	purchaseId: string
	seats: number
	perSeatCents: number
}
export type SourcePaymentRow = {
	purchaseId: string
	chargeIdentifier: string | null
	checkoutSessionIdentifier: string | null
}
/** Stripe evidence for one source purchase. seats is null when no checkout
 * quantity exists; only an unshared bulk coupon may then supply the seats. */
export type SourcePayment =
	| { chargeCents: number; seats: number | null }
	| { hold: string }
export type SourcePaymentReader = (
	rows: SourcePaymentRow[],
) => Promise<ReadonlyMap<string, SourcePayment>>
/** Real ids are purch_<uuid>, hyphens included. */
export const PURCHASE_ID = /purch_[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g
/** Purchase.totalAmount was stored rounded for some team purchases. It may only
 * corroborate the Stripe charge, never price a seat, and must agree within
 * this many cents on the purchase total. */
export const RECORDED_AMOUNT_TOLERANCE_CENTS = 100
export type CreditReceipt = CreditScope & {
	invoiceId: string
	requestHash: string
	seats: number
	amountCents: number
	currency: string
	status: CreditStatus
	allocations: CreditAllocation[]
}
export class CreditRefusal extends Error {
	constructor(
		readonly reason: string,
		readonly remaining?: { seats: number; amountCents: number },
	) {
		super(reason)
	}
}
export function positiveInteger(value: number, name: string) {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new CreditRefusal(`invalid_${name}`)
	return value
}
/** Decimal Purchase.totalAmount dollars -> exact cents. Never use binary floats. */
export function purchaseCents(value: string): number {
	const match = /^(\d+)(?:\.(\d*))?$/.exec(value)
	if (!match || /[1-9]/.test((match[2] ?? '').slice(2)))
		throw new CreditRefusal('unrepresentable_purchase_amount')
	return positiveInteger(
		Number(
			BigInt(match[1]!) * BigInt(100) +
				BigInt((match[2] ?? '').padEnd(2, '0').slice(0, 2)),
		),
		'purchase_cents',
	)
}
export function source(input: {
	purchaseId: string
	purchaseSeats: number
	chargeCents: number
	recordedAmount: string
}): CreditSource {
	const seats = positiveInteger(input.purchaseSeats, 'purchase_seats')
	const cents = positiveInteger(input.chargeCents, 'charge_cents')
	if (
		Math.abs(purchaseCents(input.recordedAmount) - cents) >=
		RECORDED_AMOUNT_TOLERANCE_CENTS
	)
		throw new CreditRefusal(
			'purchase_amount_disagrees_with_charge_hold_for_review',
		)
	// Do not invent fractional cents or round up money the team never paid.
	if (cents % seats !== 0)
		throw new CreditRefusal('fractional_per_seat_cents_hold_for_review')
	return {
		purchaseId: input.purchaseId,
		purchaseSeats: seats,
		purchaseTotalCents: cents,
		perSeatCents: positiveInteger(cents / seats, 'per_seat_cents'),
	}
}
export function requestHash(scope: CreditScope, seats: number) {
	return createHash('sha256')
		.update(
			JSON.stringify([
				C5_PRODUCT,
				scope.stripeCustomerId,
				scope.organizationId ?? null,
				seats,
			]),
		)
		.digest('hex')
}
export function creditBalance(
	sources: CreditSource[],
	spent: ReadonlyMap<string, number>,
) {
	let seats = 0
	let amountCents = 0
	for (const row of sources) {
		const used = spent.get(row.purchaseId) ?? 0
		if (!Number.isSafeInteger(used) || used < 0 || used > row.purchaseSeats)
			throw new CreditRefusal('ledger_overdrawn_hold_for_review')
		seats += row.purchaseSeats - used
		amountCents += (row.purchaseSeats - used) * row.perSeatCents
	}
	if (!Number.isSafeInteger(seats) || !Number.isSafeInteger(amountCents))
		throw new CreditRefusal('balance_out_of_range')
	return { seats, amountCents }
}
export function allocate(
	sources: CreditSource[],
	spent: ReadonlyMap<string, number>,
	seats: number,
): CreditAllocation[] {
	positiveInteger(seats, 'seats')
	const remaining = creditBalance(sources, spent)
	if (seats > remaining.seats)
		throw new CreditRefusal('insufficient_credit', remaining)
	let needed = seats
	const result: CreditAllocation[] = []
	for (const row of [...sources].sort(
		(a, b) =>
			b.perSeatCents - a.perSeatCents ||
			a.purchaseId.localeCompare(b.purchaseId),
	)) {
		const take = Math.min(
			needed,
			row.purchaseSeats - (spent.get(row.purchaseId) ?? 0),
		)
		if (take > 0) result.push({ ...row, seats: take })
		needed -= take
		if (!needed) break
	}
	return result
}
export function allocationTotal(allocations: CreditAllocation[]) {
	const amount = allocations.reduce(
		(sum, row) => sum + row.seats * row.perSeatCents,
		0,
	)
	return positiveInteger(amount, 'credit_total')
}
/** Lifecycle sketch: reserved --paid--> paid; reserved --void--> released.
 * paid/released are terminal. Stale/contradictory observations never free seats.
 * No lifecycle booleans or timers; Stripe's current invoice is the event source.
 */
export function settleStatus(
	current: CreditStatus,
	stripe: string,
): CreditStatus {
	if (stripe === 'paid') {
		if (current === 'released')
			throw new CreditRefusal('paid_after_release_hold_for_review')
		return 'paid'
	}
	if (stripe === 'void') {
		if (current === 'paid')
			throw new CreditRefusal('void_after_payment_hold_for_review')
		return 'released'
	}
	if (current !== 'reserved')
		throw new CreditRefusal('nonterminal_stripe_after_terminal_hold_for_review')
	return 'reserved'
}
