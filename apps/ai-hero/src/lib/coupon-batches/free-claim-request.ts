import { AsyncLocalStorage } from 'node:async_hooks'

import {
	hasReservedCouponField,
	isReservedCouponField,
	readCouponRequestBody,
} from './coupon-request-fields'
import { inSelectorNamespace } from './namespace'
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
	if (
		!body ||
		!inSelectorNamespace(body.couponId) ||
		isReservedCouponField(body.code)
	)
		return reject(400)
	const digest = selectorDigest(body.couponId)
	if (!digest) return reject(400)
	body.couponId = INTERNAL_COMP_CLAIM
	const headers = new Headers(request.headers)
	// Course Builder's parser expects the exact media type; normalize only a
	// rewritten comp request, never an ordinary claim.
	headers.set('content-type', 'application/json')
	headers.delete('content-length')
	return claimDigest.run(digest, () =>
		run(
			new Request(request, {
				headers,
				body: JSON.stringify(body),
			}),
		),
	)
}
