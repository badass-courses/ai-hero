import { NextRequest } from 'next/server'
import {
	authorizeExclusiveCouponSelection,
	type ExclusiveCouponAuthorizationAdapter,
} from '@/lib/exclusive-coupon-authorization'

type ProtectCourseBuilderRequestOptions = {
	adapter: ExclusiveCouponAuthorizationAdapter
	verifiedUserId?: string
	resolveServerComputedMerchantCoupon?: (input: {
		productId: string
		quantity: number
		verifiedUserId?: string
		country: string
	}) => Promise<{ id: string; type?: string | null } | null>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const stringValue = (value: unknown) =>
	typeof value === 'string' && value.length > 0 ? value : undefined

const numberValue = (value: unknown) => {
	if (value === undefined || value === null || value === '') return 1
	const number = typeof value === 'number' ? value : Number(value)
	return Number.isFinite(number) ? number : 0
}

const SENSITIVE_CHECKOUT_KEYS = [
	'productId',
	'quantity',
	'couponId',
	'usedCouponId',
	'userId',
	'bulk',
	'upgradeFromPurchaseId',
	'country',
] as const

const normalizeSensitiveCheckoutParams = (url: URL) => {
	for (const key of SENSITIVE_CHECKOUT_KEYS) {
		const values = url.searchParams.getAll(key)
		if (values.length === 0) continue
		const canonicalValue = values.at(-1)
		url.searchParams.delete(key)
		if (canonicalValue !== undefined) {
			url.searchParams.set(key, canonicalValue)
		}
	}
}

const requestWithJsonBody = (
	request: NextRequest,
	body: Record<string, unknown>,
) => {
	const headers = new Headers(request.headers)
	headers.set('content-type', 'application/json')
	headers.delete('content-length')

	return new NextRequest(request.url, {
		method: request.method,
		headers,
		body: JSON.stringify(body),
	})
}

const requestWithUrl = async (request: NextRequest, url: URL) => {
	const headers = new Headers(request.headers)
	headers.delete('content-length')
	const body =
		request.method === 'GET' || request.method === 'HEAD'
			? undefined
			: await request.clone().arrayBuffer()

	return new NextRequest(url, {
		method: request.method,
		headers,
		...(body && body.byteLength > 0 ? { body } : {}),
	})
}

const parsePricesFormattedBody = async (request: NextRequest) => {
	const contentType = request.headers.get('content-type') ?? ''
	if (contentType.includes('application/json')) {
		try {
			const body: unknown = await request.clone().json()
			return isRecord(body) ? body : null
		} catch {
			return null
		}
	}
	if (contentType.includes('application/x-www-form-urlencoded')) {
		const form = new URLSearchParams(await request.clone().text())
		const body: Record<string, unknown> = Object.fromEntries(form)
		if (body.quantity !== undefined) {
			body.quantity = numberValue(body.quantity)
		}
		if (body.autoApplyPPP !== undefined) {
			body.autoApplyPPP = body.autoApplyPPP !== 'false'
		}
		return body
	}
	return null
}

const protectPricesFormattedRequest = async (
	request: NextRequest,
	{ adapter, verifiedUserId }: ProtectCourseBuilderRequestOptions,
) => {
	const body = await parsePricesFormattedBody(request)
	if (!body) return request

	if (verifiedUserId) body.userId = verifiedUserId
	else delete body.userId

	const productId = stringValue(body.productId)
	if (!productId) return requestWithJsonBody(request, body)

	const merchantCoupon = isRecord(body.merchantCoupon)
		? body.merchantCoupon
		: undefined
	const decision = await authorizeExclusiveCouponSelection({
		adapter,
		verifiedUserId,
		productId,
		quantity: numberValue(body.quantity),
		requestedMerchantCouponId: stringValue(merchantCoupon?.id),
		requestedSiteCouponId: stringValue(body.couponId),
	})

	if (!decision.authorized) {
		delete body.merchantCoupon
		delete body.couponId
		// A PPP selection is stripped, not honored; the client disables
		// autoApplyPPP while its PPP box is checked, so re-enable it and let
		// server pricing re-derive PPP from the trusted country.
		if (decision.requestedPPP) {
			body.autoApplyPPP = true
		}
	}

	return requestWithJsonBody(request, body)
}

const protectCheckoutRequest = async (
	request: NextRequest,
	{
		adapter,
		verifiedUserId,
		resolveServerComputedMerchantCoupon,
	}: ProtectCourseBuilderRequestOptions,
) => {
	// Vercel country is trusted; the checkout query is caller-controlled.
	const trustedCountry =
		request.headers.get('x-vercel-ip-country') ||
		process.env.DEFAULT_COUNTRY ||
		'US'
	const url = new URL(request.url)
	normalizeSensitiveCheckoutParams(url)
	// Legacy checkout prefers query country, so never forward the caller value.
	url.searchParams.delete('country')
	if (verifiedUserId) url.searchParams.set('userId', verifiedUserId)
	else url.searchParams.delete('userId')

	const productId = stringValue(url.searchParams.get('productId'))
	if (!productId) return requestWithUrl(request, url)
	const quantity = numberValue(url.searchParams.get('quantity') ?? 1)

	const decision = await authorizeExclusiveCouponSelection({
		adapter,
		verifiedUserId,
		productId,
		quantity,
		requestedMerchantCouponId: stringValue(url.searchParams.get('couponId')),
		requestedSiteCouponId: stringValue(url.searchParams.get('usedCouponId')),
	})

	if (decision.authorized && decision.entitlementCouponId) {
		url.searchParams.set('usedCouponId', decision.entitlementCouponId)
	}

	if (!decision.authorized) {
		url.searchParams.delete('couponId')
		url.searchParams.delete('usedCouponId')

		const serverComputedCoupon = await resolveServerComputedMerchantCoupon?.({
			productId,
			quantity,
			verifiedUserId,
			country: trustedCountry,
		})
		if (
			serverComputedCoupon?.type === 'bulk' ||
			serverComputedCoupon?.type === 'ppp'
		) {
			url.searchParams.set('couponId', serverComputedCoupon.id)
		}
	}

	return requestWithUrl(request, url)
}

/**
 * Protect the two legacy Course Builder commerce actions before the package
 * parses caller-controlled identity and coupon selectors.
 */
export async function protectCourseBuilderRequest(
	request: NextRequest,
	options: ProtectCourseBuilderRequestOptions,
): Promise<NextRequest> {
	const pathname = request.nextUrl.pathname
	if (pathname.endsWith('/prices-formatted')) {
		return protectPricesFormattedRequest(request, options)
	}
	if (pathname.includes('/checkout/')) {
		return protectCheckoutRequest(request, options)
	}
	return request
}
