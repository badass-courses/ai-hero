import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { inngest } from '@/inngest/inngest.server'
import {
	evaluateInvoiceShortfall,
	referenceMatchesInvoiceNumber,
	senderMatchesCustomerName,
} from '@/lib/invoice-shortfall-policy'
import { log } from '@/server/logger'
import { StripePaymentAdapter } from '@coursebuilder/core/providers/stripe'
import type Stripe from 'stripe'

const POLICY_VERSION = 'under-5-percent-and-at-most-100-usd-v1'
const MAX_OPEN_INVOICES = 100

const stripe = (
	stripeProvider.options.paymentsAdapter as StripePaymentAdapter
).stripe

const idOf = (value: string | { id: string } | null) =>
	typeof value === 'string' ? value : value?.id

async function reconcileInvoice(invoice: Stripe.Invoice) {
	const customerId = idOf(invoice.customer)
	if (!customerId || !invoice.number || invoice.status !== 'open')
		return { invoiceId: invoice.id, outcome: 'not-candidate' as const }

	const [cashBalance, transactions, customer, creditNotes, invoiceLines] =
		await Promise.all([
			stripe.customers.retrieveCashBalance(customerId),
			stripe.customers.listCashBalanceTransactions(customerId, { limit: 100 }),
			stripe.customers.retrieve(customerId),
			stripe.creditNotes
				.list({ invoice: invoice.id, limit: 100 })
				.autoPagingToArray({ limit: 1_000 }),
			stripe.invoices
				.listLineItems(invoice.id, { limit: 100 })
				.autoPagingToArray({ limit: 100 }),
		])

	if (customer.deleted)
		return { invoiceId: invoice.id, outcome: 'deleted-customer' as const }

	const existingAcceptance = creditNotes.find(
		(note) =>
			note.status === 'issued' &&
			note.metadata?.automaticShortfallPolicy === POLICY_VERSION,
	)
	if (existingAcceptance) {
		const currentInvoice = await stripe.invoices.retrieve(invoice.id)
		if (currentInvoice.status !== 'paid' || currentInvoice.amount_remaining !== 0)
			throw new Error(
				`Automatic shortfall credit exists but invoice ${invoice.id} is not paid`,
			)
		return {
			invoiceId: invoice.id,
			outcome: 'already-accepted' as const,
			creditNoteId: existingAcceptance.id,
		}
	}

	const currency = invoice.currency.toLowerCase()
	const availableCashBalanceCents = cashBalance.available?.[currency] ?? 0
	const matchingFundedTransactions = transactions.data.filter((transaction) => {
		if (transaction.type !== 'funded' || !transaction.funded) return false
		return (
			transactions.data[0]?.id === transaction.id &&
			transaction.currency === currency &&
			transaction.net_amount === availableCashBalanceCents &&
			transaction.ending_balance === availableCashBalanceCents &&
			referenceMatchesInvoiceNumber(
				transaction.funded.bank_transfer.reference,
				invoice.number!,
			)
		)
	})
	const fundedTransaction = matchingFundedTransactions[0]
	const senderName = fundedTransaction?.funded?.bank_transfer.us_bank_transfer
		?.sender_name
	const productLines = invoiceLines.filter((line) => line.price?.product)

	const decision = evaluateInvoiceShortfall({
		amountRemainingCents: invoice.amount_remaining,
		availableCashBalanceCents,
		currency,
		isOneTimeInvoice: !invoice.subscription,
		isSendInvoice: invoice.collection_method === 'send_invoice',
		hasSingleProductLine:
			invoiceLines.length === 1 && productLines.length === 1,
		referenceMatchesInvoice: matchingFundedTransactions.length === 1,
		senderMatchesCustomer: senderMatchesCustomerName(
			senderName,
			invoice.customer_name ?? customer.name,
			invoice.customer_address?.line1 ?? customer.address?.line1,
		),
	})

	if (!decision.eligible) {
		if (availableCashBalanceCents > 0) {
			await log.info('invoice_shortfall.review_required', {
				invoiceId: invoice.id,
				customerId,
				currency,
				amountRemainingCents: invoice.amount_remaining,
				availableCashBalanceCents,
				reason: decision.reason,
			})
		}
		return {
			invoiceId: invoice.id,
			outcome: 'review-required' as const,
			reason: decision.reason,
		}
	}

	const creditNote = await stripe.creditNotes.create(
		{
			invoice: invoice.id,
			amount: decision.shortfallCents,
			reason: 'order_change',
			memo: `Automatically accepted bank-transfer fee shortfall under policy ${POLICY_VERSION}. No additional customer payment is due.`,
			metadata: {
				automaticShortfallPolicy: POLICY_VERSION,
				cashBalanceTransactionId: fundedTransaction!.id,
			},
		},
		{
			idempotencyKey: `invoice-shortfall:${POLICY_VERSION}:${invoice.id}`,
		},
	)

	let paidInvoice: Stripe.Invoice | undefined
	for (let attempt = 0; attempt < 5; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 2_000))
		paidInvoice = await stripe.invoices.retrieve(invoice.id)
		if (paidInvoice.status === 'paid' && paidInvoice.amount_remaining === 0) break
	}
	if (paidInvoice?.status !== 'paid' || paidInvoice.amount_remaining !== 0)
		throw new Error(
			`Credit note ${creditNote.id} was issued but invoice ${invoice.id} did not become paid`,
		)

	await log.info('invoice_shortfall.auto_accepted', {
		invoiceId: invoice.id,
		customerId,
		creditNoteId: creditNote.id,
		currency,
		shortfallCents: decision.shortfallCents,
		shortfallPercent: decision.shortfallPercent,
		policy: POLICY_VERSION,
		invoicePaid: true,
	})

	return {
		invoiceId: invoice.id,
		outcome: 'accepted' as const,
		creditNoteId: creditNote.id,
		shortfallCents: decision.shortfallCents,
	}
}

export const invoiceShortfallReconciliation = inngest.createFunction(
	{
		id: 'invoice-shortfall-reconciliation',
		name: 'Invoice Shortfall Reconciliation',
		retries: 3,
		concurrency: {
			scope: 'env',
			key: '"invoice-shortfall-reconciliation"',
			limit: 1,
		},
	},
	{ cron: '*/15 * * * *' },
	async ({ step }) => {
		const openInvoices = await step.run('load-open-invoices', async () =>
			stripe.invoices
				.list({ status: 'open', limit: 100 })
				.autoPagingToArray({ limit: MAX_OPEN_INVOICES }),
		)

		const results = []
		for (const invoice of openInvoices) {
			results.push(
				await step.run(`reconcile-${invoice.id}`, () =>
					reconcileInvoice(invoice),
				),
			)
		}

		return {
			policy: POLICY_VERSION,
			openInvoiceCount: openInvoices.length,
			accepted: results.filter((result) => result.outcome === 'accepted'),
			reviewRequired: results.filter(
				(result) => result.outcome === 'review-required',
			),
		}
	},
)
