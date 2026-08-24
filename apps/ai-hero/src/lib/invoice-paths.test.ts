import { describe, expect, it } from 'vitest'

import {
	INVOICE_DETAILS_ANCHOR,
	invoiceEditPath,
	invoicePath,
} from './invoice-paths'

describe('invoice paths', () => {
	it('builds the invoice path from the merchant charge id only', () => {
		expect(invoicePath('mch_123')).toBe('/invoices/mch_123')
	})

	it('deep-links the edit action to the details form anchor', () => {
		expect(invoiceEditPath('mch_123')).toBe(
			`/invoices/mch_123#${INVOICE_DETAILS_ANCHOR}`,
		)
	})

	it('escapes charge ids safely', () => {
		expect(invoiceEditPath('mch/../x')).toBe(
			`/invoices/mch%2F..%2Fx#${INVOICE_DETAILS_ANCHOR}`,
		)
	})
})
