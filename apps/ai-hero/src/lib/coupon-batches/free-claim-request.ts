import { AsyncLocalStorage } from 'node:async_hooks'

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
	const contentType = request.headers.get('content-type') ?? ''
	const json = contentType.includes('application/json')
	const form = contentType.includes('application/x-www-form-urlencoded')
	// Neither unsupported encoding nor its contents should reach debug logging.
	if (!json && !form && request.body)
		return Response.json('unsupported coupon request', {
			status: 415,
			headers: { 'Cache-Control': 'no-store' },
		})
	if (!request.body) return run(request)
	const raw = await request.clone().text()
	let body: Record<string, unknown>
	try {
		body = json ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))
	} catch {
		// The upstream parse error may quote an invalid JSON body.
		if (/c5comp_/i.test(raw))
			return Response.json('invalid coupon request', {
				status: 400,
				headers: { 'Cache-Control': 'no-store' },
			})
		return run(request)
	}
	if (!inSelectorNamespace(body?.couponId)) return run(request)
	const digest = selectorDigest(body.couponId)
	body.couponId = INTERNAL_COMP_CLAIM
	const headers = new Headers(request.headers)
	headers.delete('content-length')
	return claimDigest.run(digest, () =>
		run(
			new Request(request, {
				headers,
				body: json
					? JSON.stringify(body)
					: new URLSearchParams(body as Record<string, string>).toString(),
			}),
		),
	)
}
