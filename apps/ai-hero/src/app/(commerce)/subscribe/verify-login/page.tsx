import { ParsedUrlQuery } from 'querystring'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { Logo } from '@/components/brand/logo'
import LayoutClient from '@/components/layout-client'
import { Login } from '@/components/login'
import { courseBuilderAdapter, db } from '@/db'
import { purchases } from '@/db/schema'
import { env } from '@/env.mjs'
import {
	CHECKOUT_LOGIN_BROWSER_COOKIE,
	hashCheckoutLoginBrowserSession,
} from '@/lib/checkout-login-browser-session'
import {
	createCheckoutLoginHandoffEnvelope,
	hashCheckoutLoginHandoffNonce,
} from '@/lib/checkout-login-handoff'
import { checkoutLoginHandoffStore } from '@/lib/checkout-login-handoff-store'
import { authorizeExclusiveCouponSelection } from '@/lib/exclusive-coupon-authorization'
import { getProduct } from '@/lib/products-query'
import {
	hasActiveNonBulkPurchaseForProduct,
	requiresDuplicateActivePurchaseGuardrail,
} from '@/lib/purchase-guardrails'
import { getSubscriptionStatus } from '@/lib/subscriptions'
import { getProviders, getServerAuthSession } from '@/server/auth'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import { CheckoutParamsSchema } from '@coursebuilder/core/types'

export const dynamic = 'force-dynamic'

/**
 * This page is used to verify that the user is logged in and has an active subscription.
 * It is used to redirect the user to the login page if they are not logged in.
 * It is also used to redirect the user to the checkout page if they are logged in and have an active subscription.
 * @param param0
 * @returns
 */
export default async function VerifyLoginPage({
	searchParams,
}: {
	searchParams: Promise<ParsedUrlQuery>
}) {
	const headersList = await headers()
	const rawSearchParams = await searchParams
	const { checkoutUrl, ...checkoutParams } = rawSearchParams
	const { session, ability } = await getServerAuthSession()
	const user = session?.user
	const providers = getProviders()
	const product = await getProduct(checkoutParams.productId as string)

	let callbackUrl = `${env.COURSEBUILDER_URL}/subscribe/logged-in`

	const parsedCheckoutParams = CheckoutParamsSchema.safeParse(checkoutParams)

	if (!parsedCheckoutParams.success) {
		return redirect('/login')
	}

	if (requiresDuplicateActivePurchaseGuardrail(product?.type)) {
		if (user && product) {
			const guardedProductPurchases = await db.query.purchases.findMany({
				where: and(
					eq(purchases.userId, user.id),
					eq(purchases.productId, product.id),
					inArray(purchases.status, ['Valid', 'Restricted']),
					isNull(purchases.bulkCouponId),
				),
			})

			if (
				hasActiveNonBulkPurchaseForProduct(guardedProductPurchases, product.id)
			) {
				return redirect(`/invoices`)
			}

			if (typeof checkoutUrl !== 'string' || !checkoutUrl) {
				return redirect('/subscribe/error')
			}
			return redirect(safeCheckoutUrl(checkoutUrl))
		}
	}

	if (product?.type === 'membership') {
		if (user) {
			const { hasActiveSubscription } = await getSubscriptionStatus(user?.id)

			if (!hasActiveSubscription) {
				if (typeof checkoutUrl !== 'string' || !checkoutUrl) {
					return redirect('/subscribe/error')
				}
				return redirect(safeCheckoutUrl(checkoutUrl))
			} else {
				return redirect(`/subscribe/already-subscribed`)
			}
		}
	}

	/** Validates that checkoutUrl is a Stripe checkout URL to prevent open redirect. */
	function safeCheckoutUrl(url: string): string {
		try {
			const parsed = new URL(url)
			if (parsed.hostname === 'checkout.stripe.com') return url
		} catch {
			// not a valid absolute URL
		}
		return '/subscribe/error'
	}

	const cookieStore = await cookies()
	const browserSession = cookieStore.get(
		CHECKOUT_LOGIN_BROWSER_COOKIE,
	)?.value
	if (!browserSession) {
		const returnParams = new URLSearchParams()
		for (const [key, value] of Object.entries(rawSearchParams)) {
			if (Array.isArray(value)) {
				for (const item of value) returnParams.append(key, item)
			} else if (value !== undefined) {
				returnParams.set(key, value)
			}
		}
		const returnTo = `/subscribe/verify-login?${returnParams.toString()}`
		return redirect(
			`/subscribe/verify-login/browser-session?returnTo=${encodeURIComponent(returnTo)}`,
		)
	}

	if (!env.NEXTAUTH_SECRET) {
		return redirect('/subscribe/error')
	}

	const rawTrustedCountry =
		headersList.get('x-vercel-ip-country') ||
		process.env.DEFAULT_COUNTRY ||
		'US'
	const normalizedTrustedCountry = rawTrustedCountry.toUpperCase()
	const trustedCountry = /^[A-Z]{2}$/.test(normalizedTrustedCountry)
		? normalizedTrustedCountry
		: 'US'
	const couponAuthorization = await authorizeExclusiveCouponSelection({
		adapter: courseBuilderAdapter,
		verifiedUserId: user?.id,
		productId: parsedCheckoutParams.data.productId,
		quantity: parsedCheckoutParams.data.quantity ?? 1,
		requestedMerchantCouponId: parsedCheckoutParams.data.couponId,
		requestedSiteCouponId: parsedCheckoutParams.data.usedCouponId,
	})
	const now = new Date()
	const checkoutHandoff = createCheckoutLoginHandoffEnvelope({
		secret: env.NEXTAUTH_SECRET,
		country: trustedCountry,
		pppSelected: couponAuthorization.requestedPPP === true,
		productId: parsedCheckoutParams.data.productId,
		quantity: parsedCheckoutParams.data.quantity ?? 1,
		now,
	})
	await checkoutLoginHandoffStore.issue({
		nonceHash: hashCheckoutLoginHandoffNonce(
			checkoutHandoff.payload.nonce,
		),
		browserSessionHash: hashCheckoutLoginBrowserSession(browserSession),
		payload: checkoutHandoff.payload,
		boundUserId: user?.id,
		now,
	})
	const signedCheckoutParams = {
		...parsedCheckoutParams.data,
		country: trustedCountry,
		checkoutHandoff: checkoutHandoff.token,
	}
	const checkoutSearchParams = new URLSearchParams(
		Object.entries(signedCheckoutParams).flatMap(([key, value]) => {
			if (value === undefined || value === null) return []
			return [[key, String(value)]]
		}),
	)

	return (
		<LayoutClient
			withFooter={false}
			withNavigation={false}
			withContainer={false}
		>
			<Login
				image={
					<Logo className="text-muted-foreground mx-auto mb-5 flex w-full items-center justify-center opacity-90" />
				}
				title="Log in to join"
				providers={providers}
				subtitle={`We’ll create an account for you if you don’t already have one.`}
				callbackUrl={`${callbackUrl}?${checkoutSearchParams.toString()}`}
			/>
		</LayoutClient>
	)
}
