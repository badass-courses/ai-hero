import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { ttConvertkitProvider } from '@/coursebuilder/tt-convertkit-provider'
import { db } from '@/db'
import { purchases, users } from '@/db/schema'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'
import { format } from 'date-fns'
import { eq } from 'drizzle-orm'

import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/inngest/commerce/event-new-purchase-created'

export const addPurchasesConvertkit = inngest.createFunction(
	{
		id: `add-purchase-convertkit`,
		name: 'Add Purchase Convertkit',
		idempotency: 'event.user.email',
	},
	{ event: NEW_PURCHASE_CREATED_EVENT },
	async ({ event, step }) => {
		const user = await step.run('get user', async () => {
			return db.query.users.findFirst({
				where: eq(users.id, event.user.id),
				with: {
					accounts: true,
					purchases: true,
				},
			})
		})

		if (!user) throw new Error('No user found')

		const purchase = await step.run('get purchase', async () => {
			return db.query.purchases.findFirst({
				where: eq(purchases.id, event.data.purchaseId),
				with: {
					product: true,
				},
			})
		})

		if (!purchase) throw new Error('No purchase found')

		const convertkitUser = await step.run('get convertkit user', async () => {
			await log.debug('convertkit.sync.lookup', {
				purchaseId: purchase.id,
				userId: user.id,
				email: user.email,
				tagsSynced: false,
			})
			return emailListProvider.getSubscriberByEmail(user.email)
		})

		const productSlug = purchase.product.fields?.slug
		const purchasedOnFieldName = productSlug
			? `purchased_${productSlug.replace(/-/gi, '_')}_on`
			: process.env.CONVERTKIT_PURCHASED_ON_FIELD_NAME || 'purchased_on'

		if (convertkitUser && emailListProvider.updateSubscriberFields) {
			await step.run('update convertkit user', async () => {
				return emailListProvider.updateSubscriberFields?.({
					subscriberId: convertkitUser.id,
					fields: {
						[purchasedOnFieldName]: format(
							new Date(purchase.createdAt),
							'yyyy-MM-dd HH:mm:ss z',
						),
					},
				})
			})
			await log.info('convertkit.sync.primary.synced', {
				purchaseId: purchase.id,
				userId: user.id,
				email: user.email,
				tagsSynced: true,
			})
		} else {
			await log.info('convertkit.sync.primary.skipped', {
				purchaseId: purchase.id,
				userId: user.id,
				email: user.email,
				tagsSynced: false,
			})
		}

		const ttConvertkitUser = await step.run(
			'get tt convertkit user',
			async () => {
				return ttConvertkitProvider.getSubscriberByEmail(user.email)
			},
		)

		if (ttConvertkitUser && ttConvertkitProvider.updateSubscriberFields) {
			await step.run('update tt convertkit user', async () => {
				return ttConvertkitProvider.updateSubscriberFields?.({
					subscriberId: ttConvertkitUser.id,
					fields: {
						[purchasedOnFieldName]: format(
							new Date(purchase.createdAt),
							'yyyy-MM-dd HH:mm:ss z',
						),
					},
				})
			})
			await log.info('convertkit.sync.tt.synced', {
				purchaseId: purchase.id,
				userId: user.id,
				email: user.email,
				tagsSynced: true,
			})
		} else {
			await log.info('convertkit.sync.tt.skipped', {
				purchaseId: purchase.id,
				userId: user.id,
				email: user.email,
				tagsSynced: false,
			})
		}

		return 'No discord account found for user'
	},
)
