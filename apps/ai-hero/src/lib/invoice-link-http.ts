import { NextRequest, NextResponse } from 'next/server'
import { INVOICE_LINK_COOKIE } from '@/lib/invoice-link-token'
import { validateInvoiceLinkAccess } from '@/lib/invoice-links'
import { invoicePath } from '@/lib/invoice-paths'

export { INVOICE_LINK_COOKIE } from '@/lib/invoice-link-token'

/**
 * Runs in the Node proxy, before rendering or analytics. Rendering cannot set
 * or clear cookies; the page separately re-verifies every cookie it receives.
 */
export async function invoiceLinkResponse(
	request: NextRequest,
	merchantChargeId: string,
): Promise<NextResponse> {
	const path = invoicePath(merchantChargeId)
	const hasQuery = request.nextUrl.searchParams.has('t')
	const queryTokens = request.nextUrl.searchParams.getAll('t')
	const cookie = request.cookies.get(INVOICE_LINK_COOKIE)
	const token = hasQuery
		? queryTokens.length === 1
			? queryTokens[0]
			: undefined
		: cookie?.value
	const access = token
		? await validateInvoiceLinkAccess({ merchantChargeId, token })
		: ({ valid: false } as const)
	// Invalid query tokens are also removed, never rescued by an older cookie.
	// The next bare request follows the normal signed-in invoice behavior.
	const response = hasQuery
		? NextResponse.redirect(new URL(path, request.url), 307)
		: NextResponse.next()
	response.headers.set('Referrer-Policy', 'no-referrer')
	response.headers.set('Cache-Control', 'private, no-store')
	const options = {
		path,
		httpOnly: true,
		secure: true,
		sameSite: 'lax' as const,
	}
	if (hasQuery && access.valid && typeof token === 'string') {
		response.cookies.set(INVOICE_LINK_COOKIE, token, {
			...options,
			maxAge: Math.min(access.expiresAt - Math.floor(Date.now() / 1000), 3600),
		})
	} else if ((hasQuery || cookie) && !access.valid) {
		// Use the same path when clearing. A root-path delete leaves the
		// invoice-scoped cookie untouched.
		response.cookies.set(INVOICE_LINK_COOKIE, '', { ...options, maxAge: 0 })
	}
	return response
}
