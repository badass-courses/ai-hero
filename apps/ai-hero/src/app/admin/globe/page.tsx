import { notFound } from 'next/navigation'
import {
	LIVE_PURCHASE_LIMIT,
	getAdminGlobeProductOptions,
	getRecentPaidPurchases,
} from '@/lib/admin-sales-globe'
import { serializePurchaseTickerHit } from '@/lib/admin-sales-globe-contract'
import { getServerAuthSession } from '@/server/auth'

import { SalesGlobeClient } from './_components/sales-globe-client'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AdminSalesGlobePage() {
	const { ability } = await getServerAuthSession()
	if (!ability.can('manage', 'all')) {
		notFound()
	}

	const [recentPurchases, products] = await Promise.all([
		getRecentPaidPurchases({ limit: LIVE_PURCHASE_LIMIT }),
		getAdminGlobeProductOptions(),
	])

	return (
		<SalesGlobeClient
			initialPurchases={recentPurchases.map(serializePurchaseTickerHit)}
			products={products}
		/>
	)
}
