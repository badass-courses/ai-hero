import type { DbExecutor } from '@/db/client'
import { coupon } from '@/db/schema'
import { inArray } from 'drizzle-orm'

/** Adapter 3.3.0 deliberately removes driver diagnostics (including the key
 * name) from inserts. Confirm its coarse collision code against Coupon_code_key
 * with current reads; never retry a primary-key or unexplained collision. */
export async function isSelectorCollision(
	error: unknown,
	tx: DbExecutor,
	rows: { id: string; code?: string | null }[],
) {
	if (
		!error ||
		typeof error !== 'object' ||
		!('code' in error) ||
		error.code !== 'COUPON_SELECTOR_COLLISION'
	)
		return false
	const ids = [...new Set(rows.map(({ id }) => id))]
	if (ids.length !== rows.length || !ids.length) return false
	const [idMatch] = await tx
		.select({ id: coupon.id })
		.from(coupon)
		.where(inArray(coupon.id, ids))
		.limit(1)
		.for('update')
	if (idMatch) return false
	const codes = rows.flatMap(({ code }) => (code ? [code] : []))
	const uniqueCodes = [...new Set(codes)]
	if (codes.length !== uniqueCodes.length) return true
	if (!uniqueCodes.length) return false
	const [codeMatch] = await tx
		.select({ id: coupon.id })
		.from(coupon)
		.where(inArray(coupon.code, uniqueCodes))
		.limit(1)
		.for('update')
	return Boolean(codeMatch)
}
