import { db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import {
	processGoogleAdsConversionUploads,
	readGoogleAdsConversionUploadConfig,
	sinceForGoogleAdsUploadRange,
} from '@/lib/google-ads-conversion-upload'

import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/inngest/commerce/event-new-purchase-created'

const DEFAULT_LIMIT = 50

const readLimit = () => {
	const configured = Number(process.env.AIH_GOOGLE_ADS_CONVERSION_UPLOAD_LIMIT)
	return Number.isFinite(configured) && configured > 0
		? Math.min(Math.floor(configured), 500)
		: DEFAULT_LIMIT
}

export const googleAdsConversionUpload = inngest.createFunction(
	{
		id: 'google-ads-conversion-upload',
		name: 'Google Ads Conversion Upload',
		retries: 2,
		concurrency: {
			scope: 'env',
			key: '"google-ads-conversion-upload"',
			limit: 1,
		},
	},
	[{ event: NEW_PURCHASE_CREATED_EVENT }, { cron: '*/15 * * * *' }],
	async ({ event, step }) => {
		const config = await step.run('read-google-ads-upload-config', () =>
			readGoogleAdsConversionUploadConfig(),
		)
		const purchaseId =
			'name' in event && event.name === NEW_PURCHASE_CREATED_EVENT
				? event.data.purchaseId
				: undefined
		const since = purchaseId
			? undefined
			: sinceForGoogleAdsUploadRange(
					(process.env.AIH_GOOGLE_ADS_CONVERSION_UPLOAD_RANGE ?? '90d') as
						| '24h'
						| '7d'
						| '30d'
						| '90d'
						| 'all',
				)

		return await step.run('process-google-ads-conversion-uploads', () =>
			processGoogleAdsConversionUploads({
				database: db,
				config,
				purchaseId,
				productId: purchaseId
					? undefined
					: process.env.AIH_GOOGLE_ADS_PRODUCT_ID,
				since,
				limit: purchaseId ? 1 : readLimit(),
				dryRun: !config.enabled,
			}),
		)
	},
)
