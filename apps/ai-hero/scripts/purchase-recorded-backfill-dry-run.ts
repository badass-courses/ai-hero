/**
 * Dry run only. Counts Valid or Restricted purchases since a date that have no
 * purchase.recorded ContactEvent, grouped by product and kind. Issues one
 * SELECT, prints counts, and posts nothing: no ContactEvent, Contact or drovr
 * write. No ids or emails are read or printed.
 *
 *   tsx scripts/purchase-recorded-backfill-dry-run.ts [--since 2026-10-01]
 *
 * kind: new-purchase (paid) or coupon-redeemed (zero total or a redeemed bulk
 * coupon, which includes seat redemptions).
 */
import { sql } from 'drizzle-orm'

import { db } from '../src/db/client'

const sinceArg = process.argv.indexOf('--since')
const since = sinceArg > -1 ? process.argv[sinceArg + 1] : '2026-10-01'
if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
	throw new Error('--since must be YYYY-MM-DD')
}

async function main() {
	// Key mirrors purchaseRecordedSemanticKey (lowercased).
	const result = await db.execute(sql`
		SELECT p.productId AS productId,
			CASE WHEN p.redeemedBulkCouponId IS NOT NULL OR p.totalAmount = 0
				THEN 'coupon-redeemed' ELSE 'new-purchase' END AS kind,
			COUNT(*) AS missed
		FROM Purchase p
		WHERE p.status IN ('Valid', 'Restricted')
			AND p.createdAt >= ${since}
			AND NOT EXISTS (
				SELECT 1 FROM ContactEvent ce
				WHERE ce.eventType = 'purchase.recorded'
					AND ce.semanticIdempotencyKey = LOWER(CONCAT('ai-hero:purchase.recorded:purchase:', p.id))
			)
		GROUP BY p.productId, kind
		ORDER BY missed DESC
	`)
	const rows = (
		Array.isArray(result) ? result[0] : (result as any).rows
	) as Array<{
		productId: string
		kind: string
		missed: number | string
	}>
	const byKind: Record<string, number> = {}
	let total = 0
	for (const row of rows) {
		const n = Number(row.missed)
		total += n
		byKind[row.kind] = (byKind[row.kind] ?? 0) + n
		console.log(`product=${row.productId} kind=${row.kind} missed=${n}`)
	}
	console.log(
		JSON.stringify({ since, total, byKind, mode: 'dry-run', writes: 0 }),
	)
}

main()
	.catch((error) => {
		console.error(error instanceof Error ? error.message : 'failed')
		process.exitCode = 1
	})
	.finally(() => process.exit())
