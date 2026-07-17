import { db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import {
	processGoogleAdsConversionUploads,
	readGoogleAdsConversionUploadConfig,
	sinceForGoogleAdsUploadRange,
} from '@/lib/google-ads-conversion-upload'
import { classifyGoogleAdsUploadTrigger } from '@/lib/google-ads-conversion-upload-trigger'
import { processGoogleAdsSignupConversionUploads } from '@/lib/google-ads-signup-conversion-upload'

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
	async ({ event, step, logger }) => {
		const config = await step.run('read-google-ads-upload-config', () =>
			readGoogleAdsConversionUploadConfig(),
		)
		const trigger = classifyGoogleAdsUploadTrigger(
			event,
			NEW_PURCHASE_CREATED_EVENT,
		)
		const purchaseId =
			trigger.kind === 'purchase-event' ? trigger.purchaseId : undefined
		if (trigger.kind === 'purchase-event' && !purchaseId) {
			const purchases = {
				mode: 'skipped' as const,
				reason: 'purchase-event-missing-purchase-id' as const,
			}
			logger.warn('google_ads_conversion_upload.stage_skipped', {
				stage: 'purchases',
				trigger: trigger.kind,
				...purchases,
			})
			return { purchases, signups: null }
		}
		const since = trigger.kind === 'purchase-event'
			? undefined
			: sinceForGoogleAdsUploadRange(
					(process.env.AIH_GOOGLE_ADS_CONVERSION_UPLOAD_RANGE ?? '90d') as
						| '24h'
						| '7d'
						| '30d'
						| '90d'
						| 'all',
				)

		const purchases = await step.run(
			'process-google-ads-purchase-conversion-uploads',
			() =>
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
		logger.info('google_ads_conversion_upload.stage_complete', {
			stage: 'purchases',
			trigger:
				trigger.kind === 'purchase-event'
					? 'purchase-event'
					: 'fifteen-minute-cron',
			...purchases,
		})

		if (trigger.kind === 'purchase-event') {
			return { purchases, signups: null }
		}

		const signupActionResourceName =
			process.env.GOOGLE_ADS_SIGNUP_CONVERSION_ACTION_RESOURCE_NAME?.trim()
		if (!signupActionResourceName) {
			const signups = {
				mode: 'skipped' as const,
				reason: 'missing-signup-conversion-action-resource' as const,
				privacy:
					'aggregate-only-no-click-ids-no-emails-no-contact-ids' as const,
			}
			logger.warn('google_ads_conversion_upload.stage_skipped', {
				stage: 'signups',
				trigger: 'fifteen-minute-cron',
				uploadEnabled: config.enabled,
				...signups,
			})
			return { purchases, signups }
		}

		const signups = await step.run(
			'process-google-ads-signup-conversion-uploads',
			() =>
				processGoogleAdsSignupConversionUploads({
					database: db,
					config: {
						...config,
						conversionActionResourceName: signupActionResourceName,
					},
					conversionActionResourceName: signupActionResourceName,
					since,
					limit: readLimit(),
					dryRun: !config.enabled,
					includePreviewRows: false,
					retryFailed:
						process.env.AIH_GOOGLE_ADS_SIGNUP_RETRY_FAILED === 'true',
				}),
		)
		logger.info('google_ads_conversion_upload.stage_complete', {
			stage: 'signups',
			trigger: 'fifteen-minute-cron',
			...signups,
		})
		return { purchases, signups }
	},
)
