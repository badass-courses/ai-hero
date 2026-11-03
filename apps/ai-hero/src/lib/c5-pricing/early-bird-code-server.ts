import 'server-only'

import { cookies } from 'next/headers'
import { acquireDatabaseConnection } from '@/db'
import type { RowDataPacket } from 'mysql2/promise'

import {
	EARLY_BIRD_CODE_COOKIE,
	earlyBirdCouponId,
	type EarlyBirdCodeRow,
} from './early-bird-code'

/**
 * The early-bird code this browser presented, with its coupon row read fresh.
 * No cookie, a malformed id, or a request outside a request scope reads as no
 * code. A database failure throws: the hook then holds rather than charging a
 * price that ignores a code the buyer was promised.
 */
export async function presentedEarlyBirdCode(): Promise<EarlyBirdCodeRow> {
	let value: string | undefined
	try {
		value = (await cookies()).get(EARLY_BIRD_CODE_COOKIE)?.value
	} catch {
		return { couponId: null }
	}
	const couponId = earlyBirdCouponId(value)
	if (!couponId) return { couponId: null }
	const connection = await acquireDatabaseConnection()
	try {
		const [rows] = await connection.query<RowDataPacket[]>(
			'SELECT id, status, expires, maxUses, usedCount, percentageDiscount, amountDiscount, restrictedToProductId, organizationId, fields FROM AI_Coupon WHERE id = ? LIMIT 1',
			[couponId],
		)
		const row = rows[0]
		return {
			couponId,
			row: row
				? {
						id: String(row.id),
						status: Number(row.status),
						expires: row.expires ? new Date(row.expires) : null,
						maxUses: Number(row.maxUses),
						usedCount: Number(row.usedCount),
						percentageDiscount: row.percentageDiscount ?? null,
						amountDiscount: row.amountDiscount ?? null,
						restrictedToProductId: row.restrictedToProductId ?? null,
						organizationId: row.organizationId ?? null,
						fields: row.fields ?? null,
					}
				: null,
		}
	} finally {
		connection.release()
	}
}
