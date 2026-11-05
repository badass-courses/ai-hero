import { acquireDatabaseConnection, courseBuilderAdapter, db } from '@/db'
import { env } from '@/env.mjs'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'
import Stripe from 'stripe'
import {
	createEarlyAccessPorts,
	reportEarlyAccessWithPorts,
} from './early-access-ports'
import { reconcileEarlyAccessInvoicePayment } from './early-access-payment'

export const earlyAccessStripe = new Stripe(env.STRIPE_SECRET_TOKEN, {
	apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
})

export const earlyAccessPorts = createEarlyAccessPorts({
	database: db,
	adapter: courseBuilderAdapter,
	stripe: earlyAccessStripe,
	findUser: async (email) => {
		const { magicLinkIdentity } = await import('@/coursebuilder/email-provider')
		return magicLinkIdentity.findOrCreateUser(email)
	},
	acquireConnection: acquireDatabaseConnection,
	send: (event) => inngest.send(event),
})

export function reportEarlyAccess() {
	return reportEarlyAccessWithPorts(
		{ stripe: earlyAccessStripe, adapter: courseBuilderAdapter },
		earlyAccessPorts,
	)
}

export async function reconcileEarlyAccessPayment(invoiceId: string) {
	try {
		return await reconcileEarlyAccessInvoicePayment(
			{ database: db, ports: earlyAccessPorts, log },
			invoiceId,
		)
	} catch (error) {
		// Failure reaches Stripe as non-2xx so it retries; an error log makes an
		// interrupted manual marker observable even before the report runs.
		await log.error('invoice.early_access.payment_reconciliation_failed', {
			invoiceId,
		})
		throw error
	}
}
