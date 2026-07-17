import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db'
import { coupon, purchases } from '@/db/schema'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { withSkill } from '@/server/with-skill'
import { and, eq, sql } from 'drizzle-orm'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
	'Cache-Control': 'no-store, max-age=0',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

/**
 * GET /api/products/[productId]/enrollment
 * Returns enrollment stats: total purchases, seats, status breakdown,
 * and bulk coupon (multi-seat) details.
 */
const getEnrollment = async (
	request: NextRequest,
	{ params }: { params: Promise<{ productId: string }> },
) => {
	const { productId } = await params

	if (!productId) {
		return NextResponse.json(
			{ error: 'Product ID required' },
			{ status: 400, headers: corsHeaders },
		)
	}

	const { ability, user } = await getUserAbilityForRequest(request)

	if (!user) {
		return NextResponse.json(
			{ error: 'Unauthorized', docs: '/api' },
			{ status: 401, headers: corsHeaders },
		)
	}

	if (ability.cannot('update', 'Content')) {
		return NextResponse.json(
			{ error: 'Forbidden', docs: '/api' },
			{ status: 403, headers: corsHeaders },
		)
	}

	try {
		// Status breakdown
		const statusCounts = await db
			.select({
				status: purchases.status,
				count: sql<number>`COUNT(*)`.as('count'),
			})
			.from(purchases)
			.where(eq(purchases.productId, productId))
			.groupBy(purchases.status)

		const byStatus: Record<string, number> = {}
		let totalPurchases = 0
		for (const row of statusCounts) {
			byStatus[row.status] = Number(row.count)
			totalPurchases += Number(row.count)
		}

		// Bulk coupon (multi-seat) purchases: sum maxUses and usedCount
		const bulkStats = await db
			.select({
				totalMaxUses: sql<number>`COALESCE(SUM(${coupon.maxUses}), 0)`.as(
					'totalMaxUses',
				),
				totalUsedCount: sql<number>`COALESCE(SUM(${coupon.usedCount}), 0)`.as(
					'totalUsedCount',
				),
				bulkPurchaseCount: sql<number>`COUNT(*)`.as('bulkPurchaseCount'),
			})
			.from(purchases)
			.innerJoin(coupon, eq(purchases.bulkCouponId, coupon.id))
			.where(
				and(eq(purchases.productId, productId), eq(purchases.status, 'Valid')),
			)

		const bulk = bulkStats[0] ?? {
			totalMaxUses: 0,
			totalUsedCount: 0,
			bulkPurchaseCount: 0,
		}
		const unredeemedSeats =
			Number(bulk.totalMaxUses) - Number(bulk.totalUsedCount)

		// Active = Valid + Restricted (PPP)
		const activePurchases =
			(byStatus['Valid'] ?? 0) + (byStatus['Restricted'] ?? 0)

		return NextResponse.json(
			{
				productId,
				totalPurchases,
				activePurchases,
				totalSeats: activePurchases + unredeemedSeats,
				byStatus,
				bulk: {
					purchases: Number(bulk.bulkPurchaseCount),
					maxSeats: Number(bulk.totalMaxUses),
					usedSeats: Number(bulk.totalUsedCount),
					unredeemedSeats,
				},
			},
			{ headers: corsHeaders },
		)
	} catch (error) {
		return NextResponse.json(
			{ error: 'Failed to fetch enrollment stats' },
			{ status: 500, headers: corsHeaders },
		)
	}
}

export const GET = withSkill(getEnrollment)
