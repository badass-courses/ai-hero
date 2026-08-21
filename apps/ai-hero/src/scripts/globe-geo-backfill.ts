import { closeDatabasePool } from '@/db'
import { env } from '@/env.mjs'
import {
	buildGlobeGeoBackfillQuery,
	globeGeoBackfillRowFromQuery,
	GLOBE_GEO_BACKFILL_CONCURRENCY,
	parseGlobeGeoBackfillArgs,
} from '@/lib/admin-sales-globe-geo-backfill'
import {
	persistPurchaseGeoFromStripe,
	readStripeCheckoutGeo,
} from '@/lib/admin-sales-globe-stripe-geo'
import Stripe from 'stripe'

import type { PurchaseGeoWritePlan } from '@/lib/admin-sales-globe-geo'

async function mapPool<T>(
	items: readonly T[],
	concurrency: number,
	work: (item: T) => Promise<void>
): Promise<void> {
	const queue = [...items]
	const workerCount = Math.min(concurrency, queue.length)
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (queue.length > 0) {
				const item = queue.shift()
				if (item) await work(item)
			}
		})
	)
}

async function main() {
	const args = parseGlobeGeoBackfillArgs(process.argv.slice(2))
	const rows = (await buildGlobeGeoBackfillQuery({
		limit: args.limit,
		productId: args.productId,
	})).map(globeGeoBackfillRowFromQuery)

	const stripe = new Stripe(env.STRIPE_SECRET_TOKEN, {
		apiVersion: '2024-06-20',
	})

	const plans: Array<{
		purchaseId: string
		plan: PurchaseGeoWritePlan
	}> = []

	await mapPool(rows, GLOBE_GEO_BACKFILL_CONCURRENCY, async (row) => {
		const persist = args.allowWrite
			? undefined
			: async () => {
					return
				}
		const plan = await persistPurchaseGeoFromStripe({
			row,
			readGeo: (candidate) =>
				readStripeCheckoutGeo({
					sessionIdentifier: candidate.sessionIdentifier,
					chargeIdentifier: candidate.chargeIdentifier,
					stripe,
				}),
			...(persist ? { persist } : {}),
		})
		plans.push({ purchaseId: row.id, plan })
	})

	const written = plans.filter((entry) => !entry.plan.skip).length
	const skipped = plans.length - written
	const withCity = plans.filter((entry) => entry.plan.city).length
	const withGlobe = plans.filter((entry) => entry.plan.location).length

	const receipt = {
		task: 'globe-geo-backfill',
		mode: args.allowWrite ? 'allow-write' : 'dry-run',
		productId: args.productId,
		limit: args.limit,
		scanned: rows.length,
		written,
		skipped,
		withCity,
		withGlobe,
		sample: plans.slice(0, 8).map((entry) => ({
			purchaseId: entry.purchaseId,
			skip: entry.plan.skip,
			reason: entry.plan.reason,
			city: entry.plan.city,
			state: entry.plan.state,
			precision: entry.plan.location?.precision ?? null,
			source: entry.plan.source,
		})),
	}

	process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
	await closeDatabasePool()
}

void main().catch(async (error: unknown) => {
	process.stderr.write(
		`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
	)
	try {
		await closeDatabasePool()
	} catch {
		// Best effort. The process is already failing.
	}
	process.exit(1)
})
