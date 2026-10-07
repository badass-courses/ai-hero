import { INCLUDED_PRODUCT_ENTITLEMENTS_RETRY_EVENT } from '@/inngest/events/included-product-entitlements'
import { inngest } from '@/inngest/inngest.server'
import { grantIncludedProductEntitlements } from '@/lib/included-product-entitlements'
import { log } from '@/server/logger'

// Separate retry budget: a broken included-product contract must not retry or
// prevent the paid product's cohort grant. Errors carry IDs/status only.
export const includedProductEntitlementsRetry = inngest.createFunction(
	{
		id: 'included-product-entitlements-retry',
		name: 'Retry included product entitlements',
		retries: 5,
		concurrency: { limit: 1, key: 'event.data.purchaseId' },
		onFailure: async ({ event }) => {
			const data = event.data.event.data
			await log.error('included_product.grant_failed', {
				purchaseId: data.purchaseId,
				productId: data.productId,
				userId: data.userId,
				status: 'retries_exhausted',
			})
		},
	},
	{ event: INCLUDED_PRODUCT_ENTITLEMENTS_RETRY_EVENT },
	async ({ event, step }) =>
		step.run('retry included product grant', async () => {
			try {
				return await grantIncludedProductEntitlements(event.data)
			} catch (error) {
				await log.error('included_product.grant_failed', {
					purchaseId: event.data.purchaseId,
					productId: event.data.productId,
					userId: event.data.userId,
					status: 'retry_failed',
				})
				throw error
			}
		}),
)
