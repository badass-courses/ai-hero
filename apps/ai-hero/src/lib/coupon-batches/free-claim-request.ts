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
	if (
		request.method !== 'POST' ||
		!/^\/api\/coursebuilder\/redeem(?:\/[^/]+)?\/?$/.test(
			new URL(request.url).pathname,
		)
	)
		return run(request)
	const reject = (status: number) =>
		Response.json('invalid coupon request', {
			status,
			headers: { 'Cache-Control': 'no-store' },
		})
	if (
		hasReservedCouponField(new URL(request.url).searchParams, [
			'coupon',
			'code',
			'couponId',
		])
	)
		return reject(400)
	const {
		json: body,
		isJson,
		reserved,
	} = await readCouponRequestBody(request, ['couponId', 'code'])
	if (!reserved) return run(request)
	if (!isJson) return reject(415)
	if (!body || isReservedCouponField(body.code)) return reject(400)
	const cookies = request.headers.get('cookie')?.split(/;\s*/) ?? []
	const compCookie = cookies.find((value) =>
		value.startsWith(`${COMP_REDEEM_COOKIE}=`),
	)
	let code = body.couponId
	if (code === BROWSER_COMP_CLAIM) {
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
	const headers = new Headers(request.headers)
	if (compCookie) {
		const forwarded = cookies.filter(
			(value) => !value.startsWith(`${COMP_REDEEM_COOKIE}=`),
		)
		if (forwarded.length) headers.set('cookie', forwarded.join('; '))
		else headers.delete('cookie')
	}
	// Course Builder's parser expects the exact media type; normalize only a
	// rewritten comp request, never an ordinary claim.
	headers.set('content-type', 'application/json')
	headers.delete('content-length')
	return claimDigest.run(digest, () =>
		run(
			// Node's Request constructor cannot copy a build-time NextRequest wrapper.
			new Request(request.url, {
				method: request.method,
				signal: request.signal,
				headers,
				body: JSON.stringify(body),
			}),
		),
	)
}
