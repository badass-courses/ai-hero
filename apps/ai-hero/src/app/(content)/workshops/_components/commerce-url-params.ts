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
		// Older evergreen emails shipped ?claim=<site coupon id>.
		// Treat it as the existing commerce coupon selector, never as authority.
		coupon:
			searchParams.get('coupon') || searchParams.get('claim') || undefined,
		allowPurchase: searchParams.get('allowPurchase') || undefined,
	}

	return {
		params,
		hasCommerceParams:
			searchParams.has('code') ||
			searchParams.has('coupon') ||
			searchParams.has('claim') ||
			searchParams.has('allowPurchase'),
		forceAllowPurchase: params.allowPurchase === 'true',
	}
}
