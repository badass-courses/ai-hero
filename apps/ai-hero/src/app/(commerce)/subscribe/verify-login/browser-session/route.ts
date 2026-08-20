import { NextRequest, NextResponse } from 'next/server'
import {
	CHECKOUT_LOGIN_BROWSER_COOKIE,
	checkoutLoginBrowserCookieOptions,
	createCheckoutLoginBrowserSession,
} from '@/lib/checkout-login-browser-session'

export async function GET(request: NextRequest) {
	const returnTo = request.nextUrl.searchParams.get('returnTo')
	if (!returnTo || !returnTo.startsWith('/subscribe/verify-login?')) {
		return NextResponse.redirect(new URL('/subscribe/error', request.url))
	}

	const destination = new URL(returnTo, request.url)
	if (
		destination.origin !== request.nextUrl.origin ||
		destination.pathname !== '/subscribe/verify-login'
	) {
		return NextResponse.redirect(new URL('/subscribe/error', request.url))
	}

	const response = NextResponse.redirect(destination)
	response.cookies.set(
		CHECKOUT_LOGIN_BROWSER_COOKIE,
		createCheckoutLoginBrowserSession(),
		checkoutLoginBrowserCookieOptions(),
	)
	return response
}
