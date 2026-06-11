import { EntitlementSourceType } from '@/lib/entitlements'
import { log } from '@/server/logger'

import { guid } from '@coursebuilder/adapter-drizzle/mysql'

import { PRODUCT_TYPE_CONFIG } from '../config/product-types'
import { POST_PURCHASE_DISCORD_ROLE_REQUESTED_EVENT } from '../events/post-purchase-async'
import { inngest } from '../inngest.server'
import {
	USER_ADDED_TO_COHORT_EVENT,
	USER_ADDED_TO_WORKSHOP_EVENT,
} from './discord/add-discord-role-workflow'

export const postPurchaseDiscordRole = inngest.createFunction(
	{
		id: 'post-purchase-discord-role',
		name: 'Post Purchase Discord Role',
		idempotency: 'event.data.purchaseId + "-" + event.data.resourceId',
		concurrency: {
			limit: 5,
		},
	},
	{ event: POST_PURCHASE_DISCORD_ROLE_REQUESTED_EVENT },
	async ({ event, step }) => {
		const {
			purchaseId,
			userId,
			organizationId,
			organizationMembershipId,
			resourceId,
			resourceType,
			resourceProductType,
			resourceDataId,
			discordRoleId,
			discordRoleEntitlementTypeId,
		} = event.data

		const resourceConfig = PRODUCT_TYPE_CONFIG[resourceProductType]
		if (!resourceConfig) {
			await log.warn('post_purchase_discord_role.skipped', {
				purchaseId,
				userId,
				resourceId,
				resourceProductType,
				reason: 'missing_resource_config',
			})
			return { status: 'skipped', reason: 'missing_resource_config' }
		}

		await step.sendEvent(`send-discord-role-event for ${resourceId}`, {
			name:
				resourceProductType === 'cohort'
					? USER_ADDED_TO_COHORT_EVENT
					: USER_ADDED_TO_WORKSHOP_EVENT,
			data:
				resourceProductType === 'cohort'
					? {
							cohortId: resourceDataId,
							userId,
							discordRoleId,
						}
					: {
							workshopId: resourceDataId,
							userId,
							discordRoleId,
						},
		} as any)

		if (discordRoleEntitlementTypeId && discordRoleId) {
			await step.run(
				`create discord entitlement for ${resourceId}`,
				async () => {
					const entitlementId = `${resourceDataId}-discord-${guid()}`
					await resourceConfig.createEntitlement({
						id: entitlementId,
						userId,
						organizationId,
						organizationMembershipId,
						entitlementType: discordRoleEntitlementTypeId,
						sourceType: EntitlementSourceType.PURCHASE,
						sourceId: purchaseId,
						metadata: {
							discordRoleId,
						},
					})

					return { entitlementId }
				},
			)
		}

		await log.info('post_purchase_discord_role.completed', {
			purchaseId,
			userId,
			resourceId,
			resourceType,
			resourceProductType,
			discordRoleId,
		})

		return { status: 'completed' }
	},
)
