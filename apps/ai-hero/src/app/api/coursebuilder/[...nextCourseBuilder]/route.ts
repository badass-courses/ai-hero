import {
	GET as courseBuilderGET,
	POST as coreCourseBuilderPOST,
} from '@/coursebuilder/course-builder-config'
import {
	authoritativeCheckoutProduct,
	protectCommerceRequest,
} from '@/coursebuilder/protect-commerce-request'
import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { env } from '@/env.mjs'
import { INVOICE_SHORTFALL_RECONCILE_EVENT } from '@/inngest/events/invoice-shortfall'
import { inngest } from '@/inngest/inngest.server'
import { createdCheckoutSessionId } from '@/lib/c5-pricing/checkout-siblings'
import { expireC5SiblingSessions } from '@/lib/c5-pricing/server-checkout'
import {
	trustedCountryFromHeaders,
	withTrustedPricingCountry,
} from '@/lib/c5-pricing/trusted-country'
import { withSkill } from '@/server/with-skill'
import { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'
import type { NextRequest } from 'next/server'

type CashBalanceEventType =
	| 'cash_balance.funds_available'
	| 'customer_cash_balance_transaction.created'

const isCashBalanceEvent = (type: string): type is CashBalanceEventType =>
	type === 'cash_balance.funds_available' ||
	type === 'customer_cash_balance_transaction.created'

const stripe = (stripeProvider.options.paymentsAdapter as StripePaymentAdapter)
	.stripe

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
		typeof object.customer === 'string' ? object.customer : object.customer?.id
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

/** Course Builder runs with the request's trusted country in scope. */
const withTrustedCountry = <T>(request: NextRequest, run: () => T) =>
	withTrustedPricingCountry(trustedCountryFromHeaders(request.headers), run)

const courseBuilderGETWithCouponAuthorization = async (request: NextRequest) => {
	const { request: protectedRequest } = await protectCommerceRequest(request)
	if (protectedRequest instanceof Response) return protectedRequest
	return withTrustedCountry(request, () => courseBuilderGET(protectedRequest))
}

const courseBuilderPOSTWithCashBalanceReconciliation = async (
	request: NextRequest,
) => {
	const webhookRequest = request.clone()
	const { request: protectedRequest, userId } =
		await protectCommerceRequest(request)
	if (protectedRequest instanceof Response) return protectedRequest
	const response = await withTrustedCountry(request, () =>
		coreCourseBuilderPOST(protectedRequest),
	)
	if (response.ok) await dispatchCashBalanceReconciliation(webhookRequest)
	const productId = authoritativeCheckoutProduct(protectedRequest)
	const createdSessionId = productId ? createdCheckoutSessionId(response) : null
	if (productId && userId && createdSessionId) {
		await expireC5SiblingSessions({
			userId,
			productId,
			keepSessionId: createdSessionId,
		})
	}
	return response
}

export const GET = withSkill(courseBuilderGETWithCouponAuthorization)
export const POST = withSkill(courseBuilderPOSTWithCashBalanceReconciliation)
