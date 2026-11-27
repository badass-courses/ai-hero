import { AsyncLocalStorage } from 'node:async_hooks'

import {
	containsCompReference,
	inSelectorNamespace,
	isPrivateCompReference,
} from './namespace'
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
		[...new URL(request.url).searchParams.values()].some(isPrivateCompReference)
	)
		return reject(400)
	if (!request.body) return run(request)
	const raw = await request.clone().text()
	const mediaType = request.headers.get('content-type')?.split(';', 1)[0]
	const json = mediaType?.trim().toLowerCase() === 'application/json'
	if (!json) {
		const form = new URLSearchParams(raw)
		return containsCompReference(raw) ||
			[...form.values()].some(isPrivateCompReference)
			? reject(415)
			: run(request)
	}
	let body: Record<string, unknown>
	try {
		body = JSON.parse(raw)
	} catch {
		return containsCompReference(raw) ? reject(400) : run(request)
	}
	if (!inSelectorNamespace(body?.couponId))
		return isPrivateCompReference(body?.couponId) || containsCompReference(raw)
			? reject(400)
			: run(request)
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
