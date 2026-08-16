import { emailListProvider } from '@/coursebuilder/email-list-provider'
import {
	createCrashCoursePurchaserTagger,
	getRequiredKitV4ApiKey,
} from '@/coursebuilder/crash-course-purchaser-kit-v4'
import { ttConvertkitProvider } from '@/coursebuilder/tt-convertkit-provider'
import { db } from '@/db'
import { purchases, users } from '@/db/schema'
import { inngest } from '@/inngest/inngest.server'
import {
	AI_CODING_CRASH_COURSE_PURCHASED_ON_FIELD,
	formatKitPurchaseDate,
	isAiCodingCrashCoursePurchase,
} from '@/lib/crash-course-purchaser-tag'
import { log } from '@/server/logger'
import { eq } from 'drizzle-orm'

import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/inngest/commerce/event-new-purchase-created'

export const addPurchasesConvertkit = inngest.createFunction(
	{
		id: `add-purchase-convertkit`,
		name: 'Add Purchase Convertkit',
		idempotency: 'event.data.purchaseId',
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
		const dynamicPurchasedOnFieldName = productSlug
			? `purchased_${productSlug.replace(/-/gi, '_')}_on`
			: process.env.CONVERTKIT_PURCHASED_ON_FIELD_NAME || 'purchased_on'
		const isCrashCourse = isAiCodingCrashCoursePurchase(purchase.productId)
		const primaryPurchasedOnFieldName = isCrashCourse
			? AI_CODING_CRASH_COURSE_PURCHASED_ON_FIELD
			: dynamicPurchasedOnFieldName

		if (convertkitUser && emailListProvider.updateSubscriberFields) {
			// This custom property is the canonical purchase projection.
			// The product tag below only supports broadcast suppression.
			await step.run('update convertkit user', async () => {
				return emailListProvider.updateSubscriberFields?.({
					subscriberId: convertkitUser.id,
					fields: {
						[primaryPurchasedOnFieldName]: formatKitPurchaseDate(
							new Date(purchase.createdAt),
						),
					},
				})
			})

			if (isCrashCourse) {
				await step.run('tag crash course purchaser', async () => {
					const tagExistingSubscriber = createCrashCoursePurchaserTagger({
						apiKey: getRequiredKitV4ApiKey(),
					})
					return tagExistingSubscriber(String(convertkitUser.id))
				})
			}

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
						[dynamicPurchasedOnFieldName]: formatKitPurchaseDate(
							new Date(purchase.createdAt),
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
