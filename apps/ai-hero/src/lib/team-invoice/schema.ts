import { z } from 'zod'

/** Fewer than two is a personal purchase; checkout handles that. */
export const TEAM_INVOICE_MIN_SEATS = 2
/** Above this the order is a conversation, not a form: "contact us". */
export const TEAM_INVOICE_MAX_SEATS = 100

export const TEAM_INVOICE_TERMS = ['due_on_receipt', 'net_30'] as const
export type TeamInvoiceTerms = (typeof TEAM_INVOICE_TERMS)[number]

/** Days until due for each term Stripe gets. Due on receipt is day zero. */
export const DAYS_UNTIL_DUE: Record<TeamInvoiceTerms, number> = {
	due_on_receipt: 0,
	net_30: 30,
}

const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max)
		.optional()
		.transform((value) => (value ? value : undefined))

/**
 * A postal address in Stripe's shape. Optional as a whole, but a partial one
 * needs a first line and a country, or the invoice prints half an address.
 */
export const teamInvoiceAddressSchema = z
	.object({
		line1: optionalText(200),
		line2: optionalText(200),
		city: optionalText(100),
		state: optionalText(100),
		postalCode: optionalText(20),
		// ISO 3166-1 alpha-2, the only country form Stripe accepts.
		country: z
			.string()
			.trim()
			.toUpperCase()
			.optional()
			.transform((value) => (value ? value : undefined))
			.refine((value) => !value || /^[A-Z]{2}$/.test(value), {
				message: 'Use a two-letter country code, like US or DE',
			}),
	})
	.refine(
		(address) =>
			!Object.values(address).some(Boolean) ||
			Boolean(address.line1 && address.country),
		{ message: 'An address needs a first line and a country' },
	)
	// A blank address is no address, not six empty strings on the invoice.
	.transform((address) =>
		Object.values(address).some(Boolean) ? address : undefined,
	)

export type TeamInvoiceAddress = {
	line1?: string
	line2?: string
	city?: string
	state?: string
	postalCode?: string
	country?: string
}

/**
 * The self-serve team invoice form, validated again on the server. Nothing
 * here carries a price: the server prices the order from the team price rules.
 */
export const teamInvoiceSchema = z.object({
	productId: z.string().min(1),
	companyName: z.string().trim().min(1, 'Company name is required').max(120),
	billingEmail: z
		.string()
		.trim()
		.toLowerCase()
		.email('Enter a billing email'),
	seats: z.coerce
		.number()
		.int('Seats must be a whole number')
		.min(TEAM_INVOICE_MIN_SEATS, `At least ${TEAM_INVOICE_MIN_SEATS} seats`)
		.max(
			TEAM_INVOICE_MAX_SEATS,
			`More than ${TEAM_INVOICE_MAX_SEATS} seats? Contact us for a quote`,
		),
	address: teamInvoiceAddressSchema.optional(),
	taxId: optionalText(60),
	poNumber: optionalText(60),
	terms: z.enum(TEAM_INVOICE_TERMS).default('due_on_receipt'),
	// Honeypot: real people never see it, so it stays empty.
	website: z.string().optional(),
	// When the form rendered, for the too-fast and too-stale checks.
	timestamp: z.string(),
})

export type TeamInvoiceFormInput = z.input<typeof teamInvoiceSchema>
export type TeamInvoiceRequest = z.output<typeof teamInvoiceSchema>

/** What the form shows after a submit. Never carries Stripe ids. */
export type TeamInvoiceResult =
	| { kind: 'sent'; email: string }
	/** Forwarded to support: when seats open, or within a working day. */
	| { kind: 'requested'; email: string; when: 'seats-open' | 'working-day' }
	| { kind: 'price-unavailable' }
	| { kind: 'not-on-sale' }
	| { kind: 'contact-us' }
	| { kind: 'rate-limited' }
	| { kind: 'invalid'; message: string }
	| { kind: 'error' }

export const PRICE_UNAVAILABLE_MESSAGE = 'Price unavailable, contact us.'
