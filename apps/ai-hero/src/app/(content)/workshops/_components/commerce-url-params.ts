export type CommerceUrlParams = {
	code?: string
	coupon?: string
	allowPurchase?: string
}

export function readCommerceUrlParams(
	searchParams: Pick<URLSearchParams, 'get' | 'has'>,
) {
	const params: CommerceUrlParams = {
		code: searchParams.get('code') || undefined,
		coupon: searchParams.get('coupon') || undefined,
		allowPurchase: searchParams.get('allowPurchase') || undefined,
	}

	return {
		params,
		hasCommerceParams:
			searchParams.has('code') ||
			searchParams.has('coupon') ||
			searchParams.has('allowPurchase'),
		forceAllowPurchase: params.allowPurchase === 'true',
	}
}
