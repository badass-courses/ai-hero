import { AsyncLocalStorage } from 'node:async_hooks'

import {
	hasReservedCouponField,
	isReservedCouponField,
	readCouponRequestBody,
} from './coupon-request-fields'
import { COMP_REDEEM_COOKIE, parseCompCookie } from './browser-claim'
import { BROWSER_COMP_CLAIM, inSelectorNamespace } from './namespace'
import { selectorDigest } from './selector'

export const INTERNAL_COMP_CLAIM = 'batch-coupon-claim'
const claimDigest = new AsyncLocalStorage<string | null>()
export const activeCompClaimDigest = () => claimDigest.getStore() ?? null

/** Keep the bearer out of Course Builder's runtime adapter debug arguments.
 * The replacement is only meaningful inside this exact free claim request. */
export async function withPrivateCompClaim<T>(
	request: Request,
	run: (request: Request) => Promise<T>,
): Promise<T | Response> {
	const url = new URL(request.url)
	if (!/^\/api\/coursebuilder\/redeem(?:\/|$)/.test(url.pathname))
		return run(request)
	const cookies = request.headers.get('cookie')?.split(/;\s*/) ?? []
	const compCookie = cookies.find((value) =>
		value.startsWith(`${COMP_REDEEM_COOKIE}=`),
	)
	const headers = new Headers(request.headers)
	if (compCookie) {
		const forwarded = cookies.filter(
			(value) => !value.startsWith(`${COMP_REDEEM_COOKIE}=`),
		)
		if (forwarded.length) headers.set('cookie', forwarded.join('; '))
		else headers.delete('cookie')
	}
	// Construct from the URL, not the NextRequest wrapper (different
	// runtime brands in a production Next build).
	const forward = (body: BodyInit | null) =>
		run(
			new Request(request.url, {
				method: request.method,
				signal: request.signal,
				headers,
				body,
				duplex: 'half',
			} as RequestInit),
		)
	const reject = (status: number) =>
		Response.json('invalid coupon request', {
			status,
			headers: { 'Cache-Control': 'no-store' },
		})
	if (hasReservedCouponField(url.searchParams, ['coupon', 'code', 'couponId']))
		return reject(400)
	if (request.method !== 'POST')
		return compCookie ? forward(request.body) : run(request)
	const {
		json: body,
		isJson,
		reserved,
	} = await readCouponRequestBody(request, ['couponId', 'code'])
	if (!reserved) return compCookie ? forward(request.body) : run(request)
	if (!isJson) return reject(415)
	if (!body || isReservedCouponField(body.code)) return reject(400)
	let code = body.couponId
	if (code === BROWSER_COMP_CLAIM) {
		// Older/non-browser clients may omit Fetch Metadata. SameSite=Lax
		// withholds the cookie on cross-site POSTs; JSON requires CORS preflight.
		const fetchSite = request.headers.get('sec-fetch-site')
		if (fetchSite && fetchSite !== 'same-origin') return reject(400)
		try {
			code = parseCompCookie(
				decodeURIComponent(
					compCookie?.slice(COMP_REDEEM_COOKIE.length + 1) ?? '',
				),
			)?.code
		} catch {
			return reject(400)
		}
	}
	if (!inSelectorNamespace(code)) return reject(400)
	const digest = selectorDigest(code)
	if (!digest) return reject(400)
	body.couponId = INTERNAL_COMP_CLAIM
	// Course Builder's parser expects the exact media type; normalize only a
	// rewritten comp request, never an ordinary claim.
	headers.set('content-type', 'application/json')
	headers.delete('content-length')
	return claimDigest.run(digest, () => forward(JSON.stringify(body)))
}
