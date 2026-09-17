/**
 * Backfills purchase.recorded and contact.unsubscribed ContactEvents from the
 * local coursebuilder source of truth.
 *
 * Dry-run by default: reads sources, resolves identities, checks semantic
 * keys, and prints counts without writing anything. Pass --live to write the
 * missing ContactEvents (idempotent via ContactEvent_semanticIdempotencyKey_uq
 * plus the preview duplicate check).
 *
 *   pnpm contact-events:backfill                      # dry-run, all sources
 *   pnpm contact-events:backfill --source purchases   # dry-run, purchases only
 *   pnpm contact-events:backfill --limit 500          # dry-run, first 500 rows
 *   pnpm contact-events:backfill --live               # write (operator only)
 *
 * Purchases: status Valid or Restricted (the app's definition of a valid
 * purchase, see sync-purchase-tags). Unsubscribes: the local
 * CommunicationPreference mirror rows with active=false and an optOutAt —
 * Kit-side unsubscribes that never passed through an ai-hero preference flow
 * are not locally available and are NOT fabricated here.
 */
import { closeDatabasePool, db } from '@/db'
import {
	communicationChannel,
	communicationPreferences,
	communicationPreferenceTypes,
	purchases as purchasesTable,
	users as usersTable,
} from '@/db/schema'
import {
	emailPreferenceDefinitions,
	type EmailPreferenceKey,
} from '@/coursebuilder/email-preferences'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	previewContactUnsubscribedContactEvents,
	previewPurchaseRecordedContactEvents,
	writeContactUnsubscribedContactEvents,
	writePurchaseRecordedContactEvents,
	type ContactUnsubscribedSource,
	type LifecycleContactEventSummary,
	type PurchaseRecordedSource,
} from '@/lib/subscriber-marketing/lifecycle-contact-events'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'

type SourceSelection = 'purchases' | 'unsubscribes' | 'all'

function parseArgs(argv: string[]) {
	const args = {
		live: false,
		limit: undefined as number | undefined,
		source: 'all' as SourceSelection,
	}
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === '--live') args.live = true
		else if (arg === '--limit') {
			const value = Number(argv[++index])
			if (!Number.isInteger(value) || value <= 0)
				throw new Error('--limit requires a positive integer')
			args.limit = value
		} else if (arg === '--source') {
			const value = argv[++index]
			if (value !== 'purchases' && value !== 'unsubscribes' && value !== 'all')
				throw new Error('--source must be purchases, unsubscribes, or all')
			args.source = value
		} else {
			throw new Error(`Unknown argument: ${arg}`)
		}
	}
	return args
}

async function loadPurchaseSources(limit?: number) {
	const rows = await db
		.select({
			purchaseId: purchasesTable.id,
			userId: purchasesTable.userId,
			productId: purchasesTable.productId,
			status: purchasesTable.status,
			totalAmount: purchasesTable.totalAmount,
			createdAt: purchasesTable.createdAt,
			email: usersTable.email,
			name: usersTable.name,
		})
		.from(purchasesTable)
		.leftJoin(usersTable, eq(purchasesTable.userId, usersTable.id))
		.where(inArray(purchasesTable.status, ['Valid', 'Restricted']))
		.limit(limit ?? 10_000_000)
	return rows.map(
		(row): PurchaseRecordedSource => ({
			purchaseId: row.purchaseId,
			userId: row.userId,
			email: row.email,
			name: row.name,
			productId: row.productId,
			status: row.status,
			totalAmount: String(row.totalAmount),
			purchasedAt: new Date(row.createdAt).toISOString(),
		}),
	)
}

async function loadUnsubscribeSources(limit?: number) {
	const preferenceKeyByTypeName = new Map<string, EmailPreferenceKey>(
		emailPreferenceDefinitions.map((definition) => [
			definition.localPreferenceTypeName,
			definition.key,
		]),
	)
	const rows = await db
		.select({
			userId: communicationPreferences.userId,
			optOutAt: communicationPreferences.optOutAt,
			active: communicationPreferences.active,
			preferenceTypeName: communicationPreferenceTypes.name,
			channelName: communicationChannel.name,
			email: usersTable.email,
		})
		.from(communicationPreferences)
		.innerJoin(
			communicationPreferenceTypes,
			eq(communicationPreferences.preferenceTypeId, communicationPreferenceTypes.id),
		)
		.innerJoin(
			communicationChannel,
			eq(communicationPreferences.channelId, communicationChannel.id),
		)
		.innerJoin(usersTable, eq(communicationPreferences.userId, usersTable.id))
		.where(
			and(
				eq(communicationPreferences.active, false),
				isNotNull(communicationPreferences.optOutAt),
			),
		)
		.limit(limit ?? 10_000_000)
	const sources: ContactUnsubscribedSource[] = []
	let unknownPreferenceTypes = 0
	let nonEmailChannels = 0
	for (const row of rows) {
		if (row.channelName !== 'Email') {
			nonEmailChannels += 1
			continue
		}
		const preferenceKey = preferenceKeyByTypeName.get(row.preferenceTypeName)
		if (!preferenceKey) {
			unknownPreferenceTypes += 1
			continue
		}
		if (!row.email || !row.optOutAt) continue
		sources.push({
			email: row.email,
			preferenceKey,
			source: 'backfill-communication-preferences',
			occurredAt: new Date(row.optOutAt).toISOString(),
		})
	}
	return { sources, totalRows: rows.length, unknownPreferenceTypes, nonEmailChannels }
}

function printSummary(label: string, summary: LifecycleContactEventSummary) {
	console.log(`\n== ${label} (${summary.mode}) ==`)
	console.log(JSON.stringify(summary.counts, null, 2))
	const paths: Record<string, number> = {}
	for (const decision of summary.decisions) {
		if (decision.status !== 'eligible') continue
		paths[decision.identityResolutionPath] =
			(paths[decision.identityResolutionPath] ?? 0) + 1
	}
	console.log('identity resolution paths:', JSON.stringify(paths))
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	const repository = new DrizzleCaptureMarketingRepository(db)
	console.log(
		`backfill-contact-events mode=${args.live ? 'LIVE WRITE' : 'dry-run'} source=${args.source} limit=${args.limit ?? 'none'}`,
	)

	if (args.source === 'purchases' || args.source === 'all') {
		const rows = await loadPurchaseSources(args.limit)
		console.log(`loaded ${rows.length} purchase rows (status Valid/Restricted)`)
		const summary = args.live
			? await writePurchaseRecordedContactEvents({ repository, rows })
			: await previewPurchaseRecordedContactEvents({ repository, rows })
		printSummary('purchase.recorded', summary)
	}

	if (args.source === 'unsubscribes' || args.source === 'all') {
		const loaded = await loadUnsubscribeSources(args.limit)
		console.log(
			`loaded ${loaded.totalRows} local opt-out mirror rows (${loaded.sources.length} usable, ${loaded.unknownPreferenceTypes} unknown preference types, ${loaded.nonEmailChannels} non-email channels)`,
		)
		const summary = args.live
			? await writeContactUnsubscribedContactEvents({
					repository,
					rows: loaded.sources,
				})
			: await previewContactUnsubscribedContactEvents({
					repository,
					rows: loaded.sources,
				})
		printSummary('contact.unsubscribed', summary)
	}
}

main()
	.catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
	.finally(async () => {
		await closeDatabasePool()
	})
