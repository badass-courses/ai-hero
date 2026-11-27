import { closeDatabasePool, db } from '@/db/client'
import {
	previewPaidCouponBackfill,
	previewPaidCouponFlips,
} from '@/lib/paid-coupon-usage'

async function main() {
	if (process.argv.length !== 3 || process.argv[2] !== '--dry-run') {
		console.error('Usage: tsx src/scripts/paid-coupon-backfill.ts --dry-run')
		process.exitCode = 2
		return
	}
	try {
		const [counts, flips] = await Promise.all([
			previewPaidCouponBackfill(db),
			previewPaidCouponFlips(db),
		])
		console.log(
			JSON.stringify({
				total: counts.reduce((sum, row) => sum + row.count, 0),
				counts,
				flips,
			}),
		)
	} finally {
		await closeDatabasePool()
	}
}

void main().catch(() => {
	console.error('Paid coupon backfill preview failed')
	process.exitCode = 1
})
