import { ParsedUrlQuery } from 'querystring'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getCsrf } from '@/app/(user)/login/actions'
import { Logo } from '@/components/brand/logo'
import LayoutClient from '@/components/layout-client'
import { Login } from '@/components/login'
import { db } from '@/db'
import { purchases } from '@/db/schema'
import { env } from '@/env.mjs'
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
	await headers()
	const { checkoutUrl, ...checkoutParams } = await searchParams
	const { session, ability } = await getServerAuthSession()
	const user = session?.user
	const providers = getProviders()
	const csrfToken = await getCsrf()
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

	const checkoutSearchParams = new URLSearchParams(
		Object.entries(parsedCheckoutParams.data).flatMap(([key, value]) => {
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
				csrfToken={csrfToken}
				providers={providers}
				subtitle={`We’ll create an account for you if you don’t already have one.`}
				callbackUrl={`${callbackUrl}?${checkoutSearchParams.toString()}`}
			/>
		</LayoutClient>
	)
}
