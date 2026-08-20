import { ParsedUrlQuery } from 'querystring'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { CHECKOUT_LOGIN_BROWSER_COOKIE } from '@/lib/checkout-login-browser-session'
import { checkoutLoginHandoffStore } from '@/lib/checkout-login-handoff-store'
import { addKitSubscriberToCheckoutAttribution } from '@/lib/checkout-subscriber-attribution'
import { resolveLoggedInCheckoutPricing } from '@/lib/logged-in-checkout-pricing'
import { getSubscriptionStatus } from '@/lib/subscriptions'
import { getServerAuthSession } from '@/server/auth'

import { buildCheckoutAttribution } from '@coursebuilder/core/lib/checkout-attribution'
import { CheckoutParamsSchema } from '@coursebuilder/core/types'

export const dynamic = 'force-dynamic'

const readJsonCookie = (value: string | undefined) => {
	if (!value) return {}
	try {
		return JSON.parse(decodeURIComponent(value)) as Record<string, unknown>
	} catch {
		return {}
	}
}

export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<ParsedUrlQuery>
}) {
	await headers()
	const rawSearchParams = await searchParams
	const checkoutParams = CheckoutParamsSchema.parse(rawSearchParams)
	const { session } = await getServerAuthSession()
	const user = session?.user
	const headersList = await headers()
	const trustedCountry =
		headersList.get('x-vercel-ip-country') ||
		process.env.DEFAULT_COUNTRY ||
		'US'

	const organizationId = headersList.get('x-organization-id') ?? undefined

	if (!user) {
		return redirect('/login')
	}

	const { hasActiveSubscription } = await getSubscriptionStatus(user.id)

	if (hasActiveSubscription) {
		return redirect(`/subscribe/already-subscribed`)
	}

	// Rebuild attribution after auth. The login callback can be a second
	// checkout-session creation point, so it must preserve the same attribution
	// payload as the initial checkout action.
	//
	// Do not merge raw checkout callback query params into attributionSnapshot here.
	// Stripe metadata values have a small hard limit, around 500 characters.
	// The callback query includes checkout plumbing like productId, couponId,
	// cancelUrl, country, and ip_address. Merging those into attributionSnapshot
	// can make Stripe reject session creation, which strands the user after magic
	// login instead of redirecting to Stripe. Only carry bounded landing-page
	// params that were captured into ft_attr before checkout.
	const cookieStore = await cookies()
	const shortlinkRef = cookieStore.get('sl_ref')?.value
	const firstTouch = readJsonCookie(cookieStore.get('ft_attr')?.value)
	const lastTouch = readJsonCookie(cookieStore.get('lt_attr')?.value)
	const checkoutAttribution = addKitSubscriberToCheckoutAttribution({
		checkoutAttribution: buildCheckoutAttribution({
			firstTouch,
			lastTouch,
			shortlinkRef,
			selfReportedSource: checkoutParams.selfReportedSource,
		}),
		rawSubscriberId: cookieStore.get('ck_subscriber_id')?.value,
	})

	const pricing = await resolveLoggedInCheckoutPricing({
		adapter: courseBuilderAdapter,
		handoffStore: checkoutLoginHandoffStore,
		verifiedUserId: user.id,
		checkoutParams,
		checkoutHandoffToken:
			typeof rawSearchParams.checkoutHandoff === 'string'
				? rawSearchParams.checkoutHandoff
				: undefined,
		browserSession: cookieStore.get(CHECKOUT_LOGIN_BROWSER_COOKIE)?.value,
		trustedCountry,
		handoffSecret: env.NEXTAUTH_SECRET,
	})
	if (pricing.kind === 'completed') {
		return redirect(pricing.redirect)
	}
	if (pricing.kind === 'rejected') {
		return redirect(
			`/subscribe/error?reason=${encodeURIComponent(pricing.reason)}`,
		)
	}

	const authorizedCheckoutParams = {
		...checkoutParams,
		userId: user.id,
		country: pricing.country,
		couponId: pricing.couponId,
		usedCouponId: pricing.usedCouponId,
		...(organizationId && { organizationId }),
		...checkoutAttribution,
	}

	let stripe: { redirect: string }
	try {
		stripe = await stripeProvider.createCheckoutSession(
			authorizedCheckoutParams,
			courseBuilderAdapter,
		)
	} catch (error) {
		if (pricing.claim) {
			await checkoutLoginHandoffStore.failRetryable({
				claim: pricing.claim,
			})
		}
		throw error
	}

	if (pricing.claim) {
		const receiptStored = await checkoutLoginHandoffStore.complete({
			claim: pricing.claim,
			redirect: stripe.redirect,
		})
		if (!receiptStored) {
			throw new Error('checkout-login-handoff-receipt-write-failed')
		}
	}
	return redirect(stripe.redirect)
}
