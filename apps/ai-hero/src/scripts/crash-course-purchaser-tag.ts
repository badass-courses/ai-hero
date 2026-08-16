import {
	createCrashCoursePurchaserTagger,
	getRequiredKitV4ApiKey,
} from '@/coursebuilder/crash-course-purchaser-kit-v4'
import { purchases, users } from '@/db/schema'
import {
	AI_CODING_CRASH_COURSE_PRODUCT_ID,
	AI_CODING_CRASH_COURSE_PURCHASER_TAG_ID,
	AI_CODING_CRASH_COURSE_PURCHASER_TAG,
	AI_CODING_CRASH_COURSE_SLUG,
	ACTIVE_PURCHASE_STATUSES,
	projectExistingCrashCoursePurchasers,
} from '@/lib/crash-course-purchaser-tag'
import { and, asc, count, eq, inArray } from 'drizzle-orm'

const DEFAULT_LIMIT = 250
const MAX_LIMIT = 1_000

type OperatorArgs = {
	allowWrite: boolean
	limit: number
	offset: number
}

function parseArgs(argv: string[]): OperatorArgs {
	let allowWrite = false
	let dryRun = false
	let limit = DEFAULT_LIMIT
	let offset = 0

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--allow-write') {
			allowWrite = true
			continue
		}
		if (arg === '--dry-run') {
			dryRun = true
			continue
		}
		if (arg === '--limit' || arg === '--offset') {
			const value = Number(argv[index + 1])
			if (!Number.isInteger(value) || value < (arg === '--limit' ? 1 : 0)) {
				throw new Error(`${arg} requires a valid integer`)
			}
			if (arg === '--limit') limit = value
			if (arg === '--offset') offset = value
			index += 1
			continue
		}
		if (arg === '--help') {
			printUsage()
			process.exitCode = 0
			return { allowWrite: false, limit: 0, offset: 0 }
		}
		throw new Error(`Unknown argument: ${arg}`)
	}

	if (allowWrite && dryRun) {
		throw new Error('Choose --allow-write or --dry-run, not both')
	}
	if (limit > MAX_LIMIT) {
		throw new Error(`--limit must not exceed ${MAX_LIMIT}`)
	}

	return { allowWrite, limit, offset }
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	if (args.limit === 0) return

	const { closeDatabasePool, db } = await import('@/db')
	try {
		const { emailListProvider } =
			await import('@/coursebuilder/email-list-provider')
		const tagExistingSubscriber = args.allowWrite
			? createCrashCoursePurchaserTagger({
					apiKey: getRequiredKitV4ApiKey(),
				})
			: undefined
		const purchaseScope = and(
			eq(purchases.productId, AI_CODING_CRASH_COURSE_PRODUCT_ID),
			inArray(purchases.status, [...ACTIVE_PURCHASE_STATUSES]),
		)
		const [total] = await db
			.select({ value: count() })
			.from(purchases)
			.where(purchaseScope)
		const candidates = await db
			.select({ email: users.email, purchasedAt: purchases.createdAt })
			.from(purchases)
			.leftJoin(users, eq(users.id, purchases.userId))
			.where(purchaseScope)
			.orderBy(asc(purchases.createdAt), asc(purchases.id))
			.limit(args.limit)
			.offset(args.offset)

		const summary = await projectExistingCrashCoursePurchasers({
			candidates,
			allowWrite: args.allowWrite,
			provider: emailListProvider,
			tagExistingSubscriber,
		})
		const activePurchases = total?.value ?? 0

		console.log(
			JSON.stringify(
				{
					operation: 'ai-coding-crash-course-purchaser-tag',
					product: {
						id: AI_CODING_CRASH_COURSE_PRODUCT_ID,
						slug: AI_CODING_CRASH_COURSE_SLUG,
						tag: {
							id: AI_CODING_CRASH_COURSE_PURCHASER_TAG_ID,
							name: AI_CODING_CRASH_COURSE_PURCHASER_TAG,
						},
					},
					mode: summary.mode,
					bounds: {
						limit: args.limit,
						offset: args.offset,
						moreAvailable:
							args.offset + summary.counts.purchasesScanned < activePurchases,
					},
					counts: {
						activePurchases,
						...summary.counts,
					},
					safety: {
						createsSubscribers: false,
						subscribesMissingSubscribers: false,
						sendsEmail: false,
						schedulesBroadcasts: false,
						touchesOtherProducts: false,
					},
				},
				null,
				2,
			),
		)

		if (
			summary.counts.lookupFailures > 0 ||
			summary.counts.propertyFailures > 0 ||
			summary.counts.tagFailures > 0
		) {
			process.exitCode = 1
		}
	} finally {
		await closeDatabasePool()
	}
}

function printUsage() {
	console.log(`Usage:
  pnpm --filter ai-hero crash-course:purchaser-tag [--dry-run] [--limit 250] [--offset 0]
  pnpm --filter ai-hero crash-course:purchaser-tag --allow-write [--limit 250] [--offset 0]

Dry-run is the default. The command only scans Valid or Restricted purchases for product-ma254.`)
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})
