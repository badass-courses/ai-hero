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
import { kitMirrorWritesEnabled } from '@/lib/kit-mirror-writes'
import { log } from '@/server/logger'
import { eq } from 'drizzle-orm'

import {
	FULL_PRICE_COUPON_REDEEMED_EVENT,
	NEW_PURCHASE_CREATED_EVENT,
} from '@coursebuilder/core/events/commerce'

export const addPurchasesConvertkit = inngest.createFunction(
	{
		id: `add-purchase-convertkit`,
		name: 'Add Purchase Convertkit',
		idempotency: 'event.data.purchaseId',
	},
	// Team-seat redemptions emit FULL_PRICE_COUPON_REDEEMED_EVENT, never
	// NEW_PURCHASE_CREATED_EVENT, so they need their own trigger or the redeemer
	// never gets the purchased_<product>_on field the buyer exclusion keys on.
	[
		{ event: NEW_PURCHASE_CREATED_EVENT },
		{ event: FULL_PRICE_COUPON_REDEEMED_EVENT },
	],
	async ({ event, step }) => {
		// Field assignments and tag membership are safe to repeat on a step retry.
		const { user, purchase, dynamicPurchasedOnFieldName } = await step.run(
			'sync primary convertkit purchase',
			async () => {
				const user = await db.query.users.findFirst({
					where: eq(users.id, event.user.id),
					with: {
						accounts: true,
						purchases: true,
					},
				})

				if (!user) throw new Error('No user found')

				const purchase = await db.query.purchases.findFirst({
					where: eq(purchases.id, event.data.purchaseId),
					with: {
						product: true,
					},
				})

				if (!purchase) throw new Error('No purchase found')

				await log.debug('convertkit.sync.lookup', {
					purchaseId: purchase.id,
					userId: user.id,
					email: user.email,
					tagsSynced: false,
				})
				// Keep the DB lookup and TT projection even when the AI Hero mirror is off.
				const convertkitUser = kitMirrorWritesEnabled()
					? await emailListProvider.getSubscriberByEmail(user.email)
					: null

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
					await emailListProvider.updateSubscriberFields?.({
						subscriberId: convertkitUser.id,
						fields: {
							[primaryPurchasedOnFieldName]: formatKitPurchaseDate(
								new Date(purchase.createdAt),
							),
						},
					})

					if (isCrashCourse) {
						const tagExistingSubscriber = createCrashCoursePurchaserTagger({
							apiKey: getRequiredKitV4ApiKey(),
						})
						await tagExistingSubscriber(String(convertkitUser.id))
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

				return { user, purchase, dynamicPurchasedOnFieldName }
			},
		)

		await step.run('sync tt convertkit purchase', async () => {
			const ttConvertkitUser = await ttConvertkitProvider.getSubscriberByEmail(
				user.email,
			)

			if (ttConvertkitUser && ttConvertkitProvider.updateSubscriberFields) {
				await ttConvertkitProvider.updateSubscriberFields?.({
					subscriberId: ttConvertkitUser.id,
					fields: {
						[dynamicPurchasedOnFieldName]: formatKitPurchaseDate(
							new Date(purchase.createdAt),
						),
					},
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
		})

		return 'No discord account found for user'
	},
)
