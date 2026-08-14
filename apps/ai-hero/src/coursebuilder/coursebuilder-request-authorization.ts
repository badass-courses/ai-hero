import { NextRequest } from 'next/server'
import {
	authorizeExclusiveCouponSelection,
	type ExclusiveCouponAuthorizationAdapter,
} from '@/lib/exclusive-coupon-authorization'

type ProtectCourseBuilderRequestOptions = {
	adapter: ExclusiveCouponAuthorizationAdapter
	verifiedUserId?: string
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

const protectPricesFormattedRequest = async (
	request: NextRequest,
	{ adapter, verifiedUserId }: ProtectCourseBuilderRequestOptions,
) => {
	let body: unknown
	try {
		body = await request.clone().json()
	} catch {
		return request
	}
	if (!isRecord(body)) return request

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
	}

	return requestWithJsonBody(request, body)
}

const protectCheckoutRequest = async (
	request: NextRequest,
	{ adapter, verifiedUserId }: ProtectCourseBuilderRequestOptions,
) => {
	const url = new URL(request.url)
	if (verifiedUserId) url.searchParams.set('userId', verifiedUserId)
	else url.searchParams.delete('userId')

	const productId = stringValue(url.searchParams.get('productId'))
	if (!productId) return requestWithUrl(request, url)

	const decision = await authorizeExclusiveCouponSelection({
		adapter,
		verifiedUserId,
		productId,
		quantity: numberValue(url.searchParams.get('quantity') ?? 1),
		requestedMerchantCouponId: stringValue(url.searchParams.get('couponId')),
		requestedSiteCouponId: stringValue(url.searchParams.get('usedCouponId')),
	})

	if (!decision.authorized) {
		url.searchParams.delete('couponId')
		url.searchParams.delete('usedCouponId')
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
