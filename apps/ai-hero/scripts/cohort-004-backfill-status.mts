import { db } from '../src/db/index.ts'
import { entitlements, entitlementTypes, purchases } from '../src/db/schema.ts'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { readFileSync } from 'node:fs'

const REQUIRED_CONTENT_ACCESS_COUNT = 8

type Args = {
	batchFile?: string
	ids: string[]
}

type EntitlementRow = {
	id: string
	typeName: string | null
	metadata: Record<string, unknown> | null
}

function parseArgs(argv: string[]): Args {
	const ids: string[] = []
	let batchFile: string | undefined

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--') {
			continue
		}
		if (arg === '--batch-file') {
			batchFile = argv[++i]
			continue
		}
		ids.push(arg)
	}

	if (batchFile) {
		const raw = readFileSync(batchFile, 'utf8')
		const jsonStart = raw.indexOf('{\n  "ok"')
		const parsed = JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw)
		for (const result of parsed.results ?? []) {
			if (result.targetPurchaseId) ids.push(result.targetPurchaseId)
		}
	}

	return { batchFile, ids: [...new Set(ids)] }
}

function summarizeEntitlements(rows: EntitlementRow[]) {
	const countsByType = rows.reduce<Record<string, number>>((acc, row) => {
		const key = row.typeName ?? 'unknown'
		acc[key] = (acc[key] ?? 0) + 1
		return acc
	}, {})

	const contentAccessCount = countsByType.cohort_content_access ?? 0
	const discordEntitlementCount = countsByType.cohort_discord_role ?? 0
	const contentAccessComplete =
		contentAccessCount >= REQUIRED_CONTENT_ACCESS_COUNT
	const discordEntitlementPresent = discordEntitlementCount > 0

	return {
		totalEntitlements: rows.length,
		countsByType,
		contentAccessCount,
		requiredContentAccessCount: REQUIRED_CONTENT_ACCESS_COUNT,
		contentAccessComplete,
		discordEntitlementCount,
		discordEntitlementPresent,
		fulfillmentStatus: contentAccessComplete
			? discordEntitlementPresent
				? 'complete_with_discord'
				: 'content_access_complete_discord_pending'
			: rows.length > 0
				? 'partial_content_access'
				: 'pending_core_fulfillment',
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2))

	if (args.ids.length === 0) {
		throw new Error('Provide purchase ids or --batch-file <path>')
	}

	const purchaseRows: any[] = await db.query.purchases.findMany({
		where: inArray(purchases.id, args.ids),
		with: { user: true },
		orderBy: (p: any, { asc }: any) => [asc(p.createdAt)],
	} as any)

	const rows = []
	for (const purchase of purchaseRows) {
		const entitlementRows = await db
			.select({
				id: entitlements.id,
				typeName: entitlementTypes.name,
				metadata: entitlements.metadata,
			})
			.from(entitlements)
			.leftJoin(
				entitlementTypes,
				eq(entitlements.entitlementType, entitlementTypes.id),
			)
			.where(
				and(
					eq(entitlements.sourceId, purchase.id),
					isNull(entitlements.deletedAt),
				),
			)

		rows.push({
			id: purchase.id,
			userId: purchase.userId,
			email: purchase.user?.email,
			status: purchase.status,
			totalAmount: purchase.totalAmount,
			createdAt: purchase.createdAt,
			...summarizeEntitlements(entitlementRows),
			entitlementRows,
		})
	}

	const summary = rows.reduce(
		(acc: any, row: any) => {
			acc.fulfillmentStatusCounts[row.fulfillmentStatus] =
				(acc.fulfillmentStatusCounts[row.fulfillmentStatus] ?? 0) + 1
			acc.rawEntitlementCounts[row.totalEntitlements] =
				(acc.rawEntitlementCounts[row.totalEntitlements] ?? 0) + 1
			if (row.contentAccessComplete) acc.contentAccessComplete += 1
			if (row.discordEntitlementPresent) acc.discordEntitlementPresent += 1
			return acc
		},
		{
			ok: true,
			batchFile: args.batchFile,
			requestedCount: args.ids.length,
			count: rows.length,
			missingCount: args.ids.length - rows.length,
			contentAccessComplete: 0,
			discordEntitlementPresent: 0,
			fulfillmentStatusCounts: {},
			rawEntitlementCounts: {},
		},
	)

	console.log(JSON.stringify({ ...summary, rows }, null, 2))
}

main().catch((error) => {
	console.error(JSON.stringify({ ok: false, error: String(error) }, null, 2))
	process.exit(1)
})
