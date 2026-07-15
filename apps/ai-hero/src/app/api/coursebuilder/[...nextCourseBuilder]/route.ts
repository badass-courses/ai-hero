import {
	GET as courseBuilderGET,
	POST as coreCourseBuilderPOST,
} from '@/coursebuilder/course-builder-config'
import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { env } from '@/env.mjs'
import { INVOICE_SHORTFALL_RECONCILE_EVENT } from '@/inngest/events/invoice-shortfall'
import { inngest } from '@/inngest/inngest.server'
import { withSkill } from '@/server/with-skill'
import { StripePaymentAdapter } from '@coursebuilder/core/providers/stripe'
import type { NextRequest } from 'next/server'

type CashBalanceEventType =
	| 'cash_balance.funds_available'
	| 'customer_cash_balance_transaction.created'

const isCashBalanceEvent = (type: string): type is CashBalanceEventType =>
	type === 'cash_balance.funds_available' ||
	type === 'customer_cash_balance_transaction.created'

const stripe = (
	stripeProvider.options.paymentsAdapter as StripePaymentAdapter
).stripe

async function dispatchCashBalanceReconciliation(request: Request) {
	const signature = request.headers.get('stripe-signature')
	if (!signature) return

	const rawBody = await request.text()
	const stripeEvent = stripe.webhooks.constructEvent(
		rawBody,
		signature,
		env.STRIPE_WEBHOOK_SECRET,
	)
	if (!isCashBalanceEvent(stripeEvent.type)) return

	const object = stripeEvent.data.object as {
		customer?: string | { id: string }
	}
	const customerId =
		typeof object.customer === 'string'
			? object.customer
			: object.customer?.id
	if (!customerId) {
		throw new Error(
			`Stripe ${stripeEvent.type} event ${stripeEvent.id} has no customer`,
		)
	}

	await inngest.send({
		id: stripeEvent.id,
		name: INVOICE_SHORTFALL_RECONCILE_EVENT,
		data: {
			customerId,
			stripeEventId: stripeEvent.id,
			stripeEventType: stripeEvent.type,
		},
	})
}

const courseBuilderPOSTWithCashBalanceReconciliation = async (
	request: NextRequest,
) => {
	const webhookRequest = request.clone()
	const response = await coreCourseBuilderPOST(request)
	if (response.ok) await dispatchCashBalanceReconciliation(webhookRequest)
	return response
}

export const GET = withSkill(courseBuilderGET)
export const POST = withSkill(courseBuilderPOSTWithCashBalanceReconciliation)
