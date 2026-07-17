import { db } from '@/db'
import { googleAdsConversionUpload, purchases } from '@/db/schema'
import {
	processGoogleAdsConversionUploads,
	readGoogleAdsConversionUploadConfig,
	type PurchaseAttributionSource,
} from './google-ads-conversion-upload'
import { and, eq, gte } from 'drizzle-orm'

export function summarizeUploadedPurchasesByAttributionSource(
	rows: readonly { attributionSource: string; status: string }[],
) {
	const uploadedByAttributionSource: Record<PurchaseAttributionSource, number> =
		{
			checkout: 0,
			'signup-gclid-fallback': 0,
		}
	for (const row of rows) {
		if (row.status !== 'uploaded') continue
		if (
			row.attributionSource === 'checkout' ||
			row.attributionSource === 'signup-gclid-fallback'
		) {
			uploadedByAttributionSource[row.attributionSource] += 1
		}
	}
	return {
		uploaded: Object.values(uploadedByAttributionSource).reduce(
			(total, count) => total + count,
			0,
		),
		uploadedByAttributionSource,
	}
}

export async function getPurchaseConversionStatus(args: {
	database?: typeof db
	since?: Date | null
	productId?: string
	limit?: number
}) {
	const database = args.database ?? db
	const preview = await processGoogleAdsConversionUploads({
		database,
		config: readGoogleAdsConversionUploadConfig({ enabled: false }),
		since: args.since,
		productId: args.productId,
		limit: args.limit ?? 5000,
		dryRun: true,
	})
	const conditions = [eq(googleAdsConversionUpload.status, 'uploaded')]
	if (args.since) {
		conditions.push(gte(googleAdsConversionUpload.uploadedAt, args.since))
	}
	if (args.productId) conditions.push(eq(purchases.productId, args.productId))
	let localConversionStatus:
		| ReturnType<typeof summarizeUploadedPurchasesByAttributionSource>
		| { unavailable: true; reason: 'attribution-source-migration-required' }
	try {
		const ledgerRows = await database
			.select({
				attributionSource: googleAdsConversionUpload.attributionSource,
				status: googleAdsConversionUpload.status,
			})
			.from(googleAdsConversionUpload)
			.innerJoin(
				purchases,
				eq(purchases.id, googleAdsConversionUpload.purchaseId),
			)
			.where(and(...conditions))
			.limit(args.limit ?? 5000)
		localConversionStatus =
			summarizeUploadedPurchasesByAttributionSource(ledgerRows)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (!message.includes('attributionSource')) throw error
		// Read-only previews remain usable before the additive ledger migration ships.
		localConversionStatus = {
			unavailable: true,
			reason: 'attribution-source-migration-required',
		}
	}

	return {
		readOnly: true,
		preview,
		localConversionStatus,
		privacy:
			'aggregate-only-no-click-ids-no-emails-no-contact-ids-no-purchase-ids-no-ledger-ids',
	}
}
