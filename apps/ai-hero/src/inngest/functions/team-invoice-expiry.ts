import { stripeProvider } from '@/coursebuilder/stripe-provider'
import BasicEmail from '@/emails/basic-email'
import { env } from '@/env.mjs'
import { inngest } from '@/inngest/inngest.server'
import { voidExpiredTeamInvoices } from '@/lib/team-invoice/team-invoice-expiry'
import {
	loadProduct,
	openTeamInvoices,
} from '@/lib/team-invoice/team-invoice-server'
import { log } from '@/server/logger'
import { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'
import { sendAnEmail } from '@coursebuilder/utils/send-an-email'

const stripe = () =>
	(stripeProvider.options.paymentsAdapter as StripePaymentAdapter).stripe

/**
 * Hourly: voids open self-serve team invoices whose product stopped selling
 * those seats (enrollment closed, sold out, archived, unpublished), so a late
 * payment cannot grant seats fulfillment would otherwise hand out. Support
 * hears about each one.
 */
export const teamInvoiceExpiry = inngest.createFunction(
	{
		id: 'team-invoice-expiry',
		name: 'Team Invoice Expiry',
		retries: 3,
		concurrency: { scope: 'env', key: '"team-invoice-expiry"', limit: 1 },
	},
	{ cron: '20 * * * *' },
	async ({ step }) =>
		step.run('void-expired-team-invoices', () =>
			voidExpiredTeamInvoices({
				now: () => new Date(),
				openInvoices: () => openTeamInvoices(),
				loadProduct,
				voidInvoice: async (invoiceId) => {
					// Search lags; an invoice paid since then is fulfilled, not voided.
					const current = await stripe().invoices.retrieve(invoiceId)
					if (current.status !== 'open') return false
					await stripe().invoices.voidInvoice(invoiceId, undefined, {
						idempotencyKey: `team-invoice-expiry:${invoiceId}`,
					})
					return true
				},
				notify: async (invoice, reason) => {
					await sendAnEmail({
						Component: BasicEmail,
						componentProps: {
							body: `Voided self-serve team invoice ${invoice.id} (${invoice.seats} seats of ${invoice.productId}) because the product is ${reason}. The buyer may want to hear from us.`,
							messageType: 'transactional',
						},
						Subject: `Team invoice voided: ${reason}`,
						To: env.NEXT_PUBLIC_SUPPORT_EMAIL,
						type: 'transactional',
					})
				},
				log: (event, data) => log.info(event, data),
			}),
		),
)
