import type { TeamInvoiceProduct } from './create-team-invoice'
import { teamSaleState } from './sale-state'

/**
 * Open self-serve team invoices outlive the moment they were priced. Course
 * Builder's fulfillment grants whatever a paid invoice says, with no sale
 * check of its own, so the app voids an open invoice once its product is no
 * longer on sale for those seats: enrollment closed, sold out, archived or
 * unpublished. A voided invoice cannot be paid.
 */

export type OpenTeamInvoice = {
	id: string
	productId: string
	seats: number
}

export type TeamInvoiceExpiry =
	| { void: false }
	| { void: true; reason: string }

/**
 * Whether one open invoice should be voided. Its own seats are part of the
 * product's held seats, so they come off before asking whether they fit.
 */
export function teamInvoiceExpiry(
	invoice: OpenTeamInvoice,
	product: TeamInvoiceProduct | null,
	now: Date,
): TeamInvoiceExpiry {
	if (!product) return { void: true, reason: 'product-missing' }
	const sale = teamSaleState(product.product, {
		now,
		purchaseCount:
			product.purchaseCount + Math.max(0, product.heldSeats - invoice.seats),
		seats: invoice.seats,
	})
	return sale.onSale ? { void: false } : { void: true, reason: sale.reason }
}

export type TeamInvoiceExpiryDeps = {
	now: () => Date
	openInvoices: () => Promise<OpenTeamInvoice[]>
	loadProduct: (productId: string) => Promise<TeamInvoiceProduct | null>
	/** False when the invoice is no longer open (paid or voided since). */
	voidInvoice: (invoiceId: string) => Promise<boolean>
	/** Tells support, who may want to reach the buyer. */
	notify: (invoice: OpenTeamInvoice, reason: string) => Promise<void>
	log: (event: string, data: Record<string, unknown>) => Promise<void> | void
}

export async function voidExpiredTeamInvoices(
	deps: TeamInvoiceExpiryDeps,
): Promise<{ checked: number; voided: { id: string; reason: string }[] }> {
	const now = deps.now()
	const invoices = await deps.openInvoices()
	const products = new Map<string, Promise<TeamInvoiceProduct | null>>()
	const voided: { id: string; reason: string }[] = []

	for (const invoice of invoices) {
		if (!products.has(invoice.productId)) {
			products.set(invoice.productId, deps.loadProduct(invoice.productId))
		}
		const expiry = teamInvoiceExpiry(
			invoice,
			await products.get(invoice.productId)!,
			now,
		)
		if (!expiry.void) continue
		// One invoice that will not void must not keep the rest open.
		try {
			if (!(await deps.voidInvoice(invoice.id))) continue
		} catch (error) {
			await deps.log('team_invoice.void_failed', {
				invoiceId: invoice.id,
				message: error instanceof Error ? error.message : String(error),
			})
			continue
		}
		await deps.notify(invoice, expiry.reason)
		await deps.log('team_invoice.voided', {
			invoiceId: invoice.id,
			productId: invoice.productId,
			seats: invoice.seats,
			reason: expiry.reason,
		})
		voided.push({ id: invoice.id, reason: expiry.reason })
	}
	return { checked: invoices.length, voided }
}
