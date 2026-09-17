/**
 * Paths for the invoice pages (AIH-259). The edit path deep-links to the
 * invoice details form on the invoice detail page. Only the merchant charge
 * id ever appears in these URLs, never billing values.
 */

export const INVOICE_DETAILS_ANCHOR = 'invoice-details'

export function invoicePath(merchantChargeId: string): string {
	return `/invoices/${encodeURIComponent(merchantChargeId)}`
}

export function invoiceEditPath(merchantChargeId: string): string {
	return `${invoicePath(merchantChargeId)}#${INVOICE_DETAILS_ANCHOR}`
}
