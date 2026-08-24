import { NextRequest, NextResponse } from 'next/server'
import {
	getRecentPaidPurchases,
	normalizeProductId,
	normalizePurchaseLimit,
} from '@/lib/admin-sales-globe'
import { serializePurchaseTickerHit } from '@/lib/admin-sales-globe-contract'
import { getServerAuthSession } from '@/server/auth'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

function errorResponse(status: 401 | 403, message: string) {
	return NextResponse.json(
		{ error: message },
		{ status, headers: NO_STORE_HEADERS },
	)
}

export async function GET(request: NextRequest) {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user) {
		return errorResponse(401, 'Unauthorized')
	}
	if (!ability.can('manage', 'all')) {
		return errorResponse(403, 'Admin access required')
	}

	const search = new URL(request.url).searchParams
	const rawLimit = search.get('limit')
	const limit = normalizePurchaseLimit(
		rawLimit === null ? undefined : Number(rawLimit),
	)
	const productId = normalizeProductId(search.get('productId'))
	const purchases = await getRecentPaidPurchases({ limit, productId })

	return NextResponse.json(
		{ purchases: purchases.map(serializePurchaseTickerHit) },
		{ headers: NO_STORE_HEADERS },
	)
}
