import { Effect } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { courseBuilderAdapter, db } from '../src/db/index.ts'
import { purchases, users } from '../src/db/schema.ts'
import { inngest } from '../src/inngest/inngest.server.ts'
import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/inngest/commerce/event-new-purchase-created'

const SOURCE_PRODUCT_ID = 'product-7t9ek'
const TARGET_PRODUCT_ID = 'product-pqkk5'
const MIGRATION_BATCH_ID = 'cohort-003-to-004-2026-05-18'
const VALID_STATUSES = ['Valid', 'Restricted'] as const

type Args = {
	dryRun: boolean
	limit?: number
	offset: number
	confirm?: string
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	const out: Args = { dryRun: true, offset: 0 }
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === '--apply') out.dryRun = false
		else if (arg === '--dry-run') out.dryRun = true
		else if (arg === '--limit') out.limit = Number(args[++i])
		else if (arg === '--offset') out.offset = Number(args[++i] ?? 0)
		else if (arg === '--confirm') out.confirm = args[++i]
		else if (arg === '--help') {
			console.log(
				`Usage: pnpm cohort-004:backfill-purchases [--dry-run] [--apply --confirm ${MIGRATION_BATCH_ID}] [--limit N] [--offset N]`,
			)
			process.exit(0)
		}
	}
	return out
}

const program = Effect.gen(function* () {
	const args = parseArgs()

	if (!args.dryRun && args.confirm !== MIGRATION_BATCH_ID) {
		throw new Error(`Refusing to apply without --confirm ${MIGRATION_BATCH_ID}`)
	}

	const sourcePurchases = yield* Effect.promise(() =>
		db.query.purchases.findMany({
			where: and(
				eq(purchases.productId, SOURCE_PRODUCT_ID),
				inArray(purchases.status, [...VALID_STATUSES]),
			),
			with: { user: true },
			orderBy: (p, { asc }) => [asc(p.createdAt), asc(p.id)],
		} as any),
	)

	const eligible = sourcePurchases
		.filter((purchase: any) => Boolean(purchase.userId && purchase.user))
		.slice(args.offset, args.limit ? args.offset + args.limit : undefined)

	const sourceUserIds = Array.from(new Set(eligible.map((p: any) => p.userId)))
	const existingTargetPurchases = sourceUserIds.length
		? yield* Effect.promise(() =>
				db.query.purchases.findMany({
					where: and(
						eq(purchases.productId, TARGET_PRODUCT_ID),
						inArray(purchases.status, [...VALID_STATUSES]),
						inArray(purchases.userId as any, sourceUserIds),
					),
				} as any),
			)
		: []

	const usersWithTarget = new Set(
		existingTargetPurchases.map((p: any) => p.userId),
	)
	const candidates = eligible.filter(
		(purchase: any) => !usersWithTarget.has(purchase.userId),
	)

	const results: any[] = []

	for (const sourcePurchase of candidates) {
		const user = sourcePurchase.user
		const newPurchaseId = `purchase-c004-backfill-${sourcePurchase.id}`

		const existingById = yield* Effect.promise(() =>
			db.query.purchases.findFirst({ where: eq(purchases.id, newPurchaseId) }),
		)

		if (existingById) {
			results.push({
				sourcePurchaseId: sourcePurchase.id,
				targetPurchaseId: newPurchaseId,
				userId: user.id,
				status: 'skipped_existing_id',
			})
			continue
		}

		const purchaseInput = {
			id: newPurchaseId,
			userId: sourcePurchase.userId,
			productId: TARGET_PRODUCT_ID,
			status: sourcePurchase.status,
			totalAmount: '0',
			organizationId: sourcePurchase.organizationId ?? null,
			purchasedByorganizationMembershipId:
				sourcePurchase.purchasedByorganizationMembershipId ?? null,
			couponId: null,
			merchantChargeId: null,
			merchantSessionId: null,
			bulkCouponId: null,
			redeemedBulkCouponId: null,
			upgradedFromId: null,
			fields: {
				backfill: true,
				backfillReason: 'cohort_003_includes_cohort_004',
				migrationBatchId: MIGRATION_BATCH_ID,
				sourceProductId: SOURCE_PRODUCT_ID,
				targetProductId: TARGET_PRODUCT_ID,
				sourcePurchaseId: sourcePurchase.id,
				sourcePurchaseStatus: sourcePurchase.status,
				sourcePurchaseCreatedAt:
					sourcePurchase.createdAt?.toISOString?.() ?? sourcePurchase.createdAt,
			},
		}

		if (args.dryRun) {
			results.push({
				sourcePurchaseId: sourcePurchase.id,
				targetPurchaseId: newPurchaseId,
				userId: user.id,
				email: user.email,
				status: 'dry_run_would_create',
				purchaseStatus: sourcePurchase.status,
			})
			continue
		}

		const created = yield* Effect.promise(() =>
			courseBuilderAdapter.createPurchase(purchaseInput as any),
		)

		yield* Effect.promise(() =>
			inngest.send({
				name: NEW_PURCHASE_CREATED_EVENT,
				data: {
					purchaseId: created.id,
					productType: 'cohort',
					quantity: 1,
					customerEmail: user.email,
				},
				user,
			} as any),
		)

		results.push({
			sourcePurchaseId: sourcePurchase.id,
			targetPurchaseId: created.id,
			userId: user.id,
			email: user.email,
			status: 'created_and_event_sent',
			purchaseStatus: sourcePurchase.status,
		})
	}

	return {
		ok: true,
		dryRun: args.dryRun,
		sourceProductId: SOURCE_PRODUCT_ID,
		targetProductId: TARGET_PRODUCT_ID,
		migrationBatchId: MIGRATION_BATCH_ID,
		sourcePurchasesFound: sourcePurchases.length,
		eligibleWindowCount: eligible.length,
		existingTargetPurchaseUsers: usersWithTarget.size,
		candidatesCount: candidates.length,
		processedCount: results.length,
		results,
	}
})

Effect.runPromise(program)
	.then((result) => {
		console.log(JSON.stringify(result, null, 2))
	})
	.catch((error) => {
		console.error(
			JSON.stringify(
				{
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				},
				null,
				2,
			),
		)
		process.exit(1)
	})
