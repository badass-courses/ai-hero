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
import { emitBuyPath } from '@/lib/buy-path/server'
import { signBuyPathToken } from '@/lib/buy-path/token'
import { buyPathIdSchema } from '@/lib/buy-path/schema'
import { log } from '@/server/logger'
import { withCheckoutTelemetry } from '@/lib/buy-path/checkout-context'
import { installBuyPathLegacyAliases } from '@/lib/buy-path/legacy-logger'

import { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'
import type { NextRequest } from 'next/server'

installBuyPathLegacyAliases()

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
	if (stripeEvent.type === 'checkout.session.completed') {
		const session = stripeEvent.data.object
		try {
			await emitBuyPath(
				{
					buyPathId: session.id,
					purchaseId: null,
					productId: session.metadata?.productId ?? null,
					userId: session.metadata?.userId ?? null,
					paymentAt: stripeEvent.created * 1000,
				},
				'webhook_received',
				{
					...(typeof session.amount_total === 'number'
						? { amountCents: session.amount_total }
						: {}),
				},
			)
		} catch {
			// Neither telemetry nor its error sink may block gift settlement.
			try {
				await log.error('buy_path.webhook_telemetry_failed', {
					buyPathId: session.id,
				})
			} catch {
				/* Best effort only. */
			}
		}
	}
	if (
		stripeEvent.type === 'checkout.session.expired' ||
		stripeEvent.type === 'checkout.session.completed' ||
		stripeEvent.type === 'checkout.session.async_payment_succeeded'
	) {
		const { settleGiftSession } =
			await import('@/lib/c5-pricing/gift-settlement')
		await settleGiftSession(
			await stripe.checkout.sessions.retrieve(stripeEvent.data.object.id),
		)
	}
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

const courseBuilderGETWithCouponAuthorization = async (
	request: NextRequest,
) => {
	const { request: protectedRequest } = await protectCommerceRequest(request)
	if (protectedRequest instanceof Response) return protectedRequest
	return withTrustedCountry(request, () => courseBuilderGET(protectedRequest))
}

const courseBuilderPOSTWithCashBalanceReconciliation = async (
	request: NextRequest,
) => {
	const startedAt = Date.now()
	const webhookRequest = request.clone()
	const { request: protectedRequest, userId } =
		await protectCommerceRequest(request)
	if (protectedRequest instanceof Response) return protectedRequest
	const rawPre = request.cookies.get('buy_path_pre')?.value
	const preSessionId =
		rawPre?.startsWith('pre_') && buyPathIdSchema.safeParse(rawPre).success
			? rawPre
			: null
	const { value: response, decisionKind } = await withCheckoutTelemetry(
		preSessionId,
		() =>
			withTrustedCountry(request, () =>
				coreCourseBuilderPOST(protectedRequest),
			),
	)
	// Preserve reservation settlement even when the core handler failed.
	if (response.ok || webhookRequest.headers.has('stripe-signature')) {
		try {
			await dispatchCashBalanceReconciliation(webhookRequest)
		} catch (error) {
			if (
				error instanceof Error &&
				error.constructor.name === 'StripeSignatureVerificationError'
			)
				return new Response(null, { status: 400 })
			throw error
		}
	}
	const authoritativeProductId = authoritativeCheckoutProduct(protectedRequest)
	const productId = protectedRequest.nextUrl.pathname.includes('/checkout/')
		? protectedRequest.nextUrl.searchParams.get('productId')
		: null
	const createdSessionId = productId ? createdCheckoutSessionId(response) : null
	if (productId && !createdSessionId && response.ok) {
		await log.error('buy_path.checkout_created', {
			buyPathId: null,
			productId,
			userId: userId ?? null,
			outcome: 'failed',
			field: 'buyPathId',
		})
	}
	if (productId && createdSessionId) {
		try {
			await emitBuyPath(
				{
					buyPathId: createdSessionId,
					preSessionId,
					productId,
					userId: userId ?? null,
					purchaseId: null,
				},
				'checkout_created',
				{
					durationMs: Date.now() - startedAt,
					decisionKind: decisionKind ?? 'legacy',
				},
			)
			await emitBuyPath(
				{
					buyPathId: createdSessionId,
					preSessionId,
					productId,
					userId: userId ?? null,
					purchaseId: null,
				},
				'redirect_to_stripe',
			)
			if (env.NEXTAUTH_SECRET)
				response.headers.append(
					'set-cookie',
					`buy_path_session=${signBuyPathToken({ buyPathId: createdSessionId, preSessionId, productId, userId: userId ?? null, expiresAt: Date.now() + 3600000 }, env.NEXTAUTH_SECRET)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${request.nextUrl.protocol === 'https:' ? '; Secure' : ''}`,
				)
		} catch {
			await log.error('buy_path.checkout_telemetry_failed', {
				buyPathId: createdSessionId,
				productId,
			})
		}
	}
	if (authoritativeProductId && userId && createdSessionId) {
		await expireC5SiblingSessions({
			userId,
			productId: authoritativeProductId,
			keepSessionId: createdSessionId,
		})
	}
	return response
}

export const GET = withSkill(courseBuilderGETWithCouponAuthorization)
export const POST = withSkill(courseBuilderPOSTWithCashBalanceReconciliation)
