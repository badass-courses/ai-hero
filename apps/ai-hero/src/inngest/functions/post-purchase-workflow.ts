import config from '@/config'
import { courseBuilderAdapter, db } from '@/db'
import { entitlements, entitlementTypes } from '@/db/schema'
import LiveOfficeHoursInvitation, {
	generateICSAttachments,
} from '@/emails/live-office-hours-invitation'
import WelcomeArchiveEmail from '@/emails/welcome-archive-email'
import WelcomeCohortEmailForTeam from '@/emails/welcome-cohort-email-team'
import WelcomeWorkshopEmailForTeam from '@/emails/welcome-workshop-email-team'
import { env } from '@/env.mjs'
import { inngest } from '@/inngest/inngest.server'
import {
	ARCHIVE_PRODUCT_TYPE,
	ensureArchiveEntitlementContext,
	getArchiveProductPolicy,
	persistArchivePolicySnapshot,
	reconcileArchivePurchaseEntitlements,
} from '@/lib/archive-products'
import { EntitlementSourceType } from '@/lib/entitlements'
import { createResourceEntitlements } from '@/lib/entitlements-query'
import type { WorkshopAvailability } from '@/lib/get-workshop-availability'
import { ensurePersonalOrganizationWithLearnerRole } from '@/lib/personal-organization-service'
import { log } from '@/server/logger'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'

import { guid } from '@coursebuilder/adapter-drizzle/mysql'
import { FULL_PRICE_COUPON_REDEEMED_EVENT } from '@coursebuilder/core/inngest/commerce/event-full-price-coupon-redeemed'
import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/inngest/commerce/event-new-purchase-created'
import {
	ContentResourceSchema,
	type ContentResource,
} from '@coursebuilder/core/schemas'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'
import { sendAnEmail } from '@coursebuilder/utils/send-an-email'

// Import shared configuration and utilities
import {
	ENTITLEMENT_CONFIG,
	gatherResourceContexts,
	getDiscordRoleId,
	getResourceData,
	PRODUCT_TYPE_CONFIG,
	ProductType,
	type ResourceContext,
} from '../config/product-types'
import { GRANT_COUPON_ENTITLEMENTS_FOR_PURCHASE_EVENT } from '../events/grant-coupon-entitlements-for-purchase'
import { GRANT_LEGEND_DISCORD_ROLE_EVENT } from '../events/grant-legend-discord-role'
import {
	POST_PURCHASE_DISCORD_ROLE_REQUESTED_EVENT,
	POST_PURCHASE_WELCOME_EMAIL_REQUESTED_EVENT,
} from '../events/post-purchase-async'

const DEFAULT_INNGEST_CONCURRENCY_LIMIT = 5

const getPostPurchaseConcurrencyLimit = () => {
	const configuredLimit = Number(
		process.env.CB_INNGEST_POST_PURCHASE_CONCURRENCY_LIMIT ??
			process.env.CB_INNGEST_CONCURRENCY_LIMIT ??
			DEFAULT_INNGEST_CONCURRENCY_LIMIT,
	)

	return Number.isFinite(configuredLimit) && configuredLimit > 0
		? configuredLimit
		: DEFAULT_INNGEST_CONCURRENCY_LIMIT
}

/**
 * Generate content URL based on product type and resource
 */
export const generateContentUrl = (
	resource: ContentResource,
	productType: ProductType,
	workshopAvailability?: WorkshopAvailability | null,
) => {
	if (productType === 'cohort') {
		// Link to first available workshop, or cohort page if none available
		const firstAvailable = workshopAvailability?.availableNow?.[0]
		if (firstAvailable) {
			return (
				env.NEXT_PUBLIC_URL +
				getResourcePath('workshop', firstAvailable.slug, 'view')
			)
		}

		// Fallback: use cohort's own resource path
		return (
			env.NEXT_PUBLIC_URL +
			getResourcePath(resource.type, resource.fields?.slug, 'view')
		)
	} else {
		return (
			env.NEXT_PUBLIC_URL +
			getResourcePath(resource.type, resource.fields?.slug, 'view')
		)
	}
}

const tracePostPurchase = async (
	phase: string,
	data: Record<string, unknown>,
	level: 'info' | 'warn' | 'error' = 'info',
) => {
	await log[level]('post_purchase.trace', {
		telemetrySchemaVersion: 1,
		phase,
		...data,
	})

	// These breadcrumbs are incident telemetry. Flush so the last known phase
	// survives Vercel runtime kills and Inngest retries.
	try {
		await log.flush()
	} catch (error) {
		console.error('[post_purchase.trace] flush failed', error)
	}
}

/**
 * Unified Post-Purchase Workflow
 * Handles both cohort and workshop purchases with shared logic
 */
export const postPurchaseWorkflow = inngest.createFunction(
	{
		id: `post-purchase-workflow`,
		name: `Post Purchase Followup Workflow`,
		idempotency: 'event.data.purchaseId',
		priority: {
			run: '120',
		},
		concurrency: {
			scope: 'env',
			key: '"post-purchase-access"',
			limit: getPostPurchaseConcurrencyLimit(),
		},
	},
	[
		{
			event: NEW_PURCHASE_CREATED_EVENT,
			if: 'event.data.productType == "cohort" || event.data.productType == "self-paced" || event.data.productType == "cohort-archive"',
		},
		{
			event: FULL_PRICE_COUPON_REDEEMED_EVENT,
			if: 'event.data.productType == "cohort" || event.data.productType == "self-paced" || event.data.productType == "cohort-archive"',
		},
	],
	async ({ event, step, db: adapter, paymentProvider, runId }) => {
		const workflowStartedAt = Date.now()
		const purchaseId = event.data.purchaseId
		const productType = event.data.productType as
			| ProductType
			| typeof ARCHIVE_PRODUCT_TYPE
		const traceBase = {
			runId,
			eventName: event.name,
			purchaseId,
			productType,
			checkoutSessionId:
				'checkoutSessionId' in event.data ? event.data.checkoutSessionId : null,
		}

		await tracePostPurchase('workflow.started', traceBase)

		if (
			productType !== ARCHIVE_PRODUCT_TYPE &&
			!ENTITLEMENT_CONFIG[productType]
		) {
			throw new Error(`Unsupported product type: ${productType}`)
		}

		// Step 1: Get purchase data
		const purchase = await step.run(`get purchase`, async () => {
			return adapter.getPurchase(event.data.purchaseId)
		})

		if (!purchase) {
			await tracePostPurchase('purchase.missing', traceBase, 'error')
			throw new Error(`purchase not found`)
		}

		await tracePostPurchase('purchase.loaded', {
			...traceBase,
			userId: purchase.userId,
			purchaseProductId: purchase.productId,
			purchaseStatus: purchase.status,
			totalAmount: purchase.totalAmount,
			bulkCouponId: purchase.bulkCouponId,
			redeemedBulkCouponId: purchase.redeemedBulkCouponId,
			organizationId: purchase.organizationId,
			createdAt: purchase.createdAt,
		})

		// Step 2: Get product data
		const product = await step.run(`get product`, async () => {
			return adapter.getProduct(purchase.productId as string)
		})

		if (!product) {
			await tracePostPurchase('product.missing', traceBase, 'error')
			throw new Error(`product not found`)
		}

		await tracePostPurchase('product.loaded', {
			...traceBase,
			purchaseProductId: product.id,
			productResourceCount: product.resources?.length ?? 0,
			productName: product.name,
		})

		// Step 3: Get user data
		const user = await step.run(`get user`, async () => {
			return adapter.getUserById(purchase.userId as string)
		})

		if (!user) {
			await tracePostPurchase('user.missing', traceBase, 'error')
			throw new Error(`user not found`)
		}

		await tracePostPurchase('user.loaded', {
			...traceBase,
			userId: user.id,
			hasEmail: Boolean(user.email),
		})

		// Step 4: Determine purchase characteristics
		const isTeamPurchase = Boolean(purchase.bulkCouponId)
		const isFullPriceCouponRedemption = Boolean(purchase.redeemedBulkCouponId)

		// Note: Shortlink attribution is handled by the dedicated shortlink-attribution
		// inngest function which runs for ALL purchase types

		// Step 5: Grant coupon-based entitlements for new purchase
		await tracePostPurchase('coupon_entitlement_event.sending', {
			...traceBase,
			userId: purchase.userId || user.id,
			purchaseStatus: purchase.status,
			totalAmount: purchase.totalAmount,
			bulkCouponId: purchase.bulkCouponId,
		})

		await step.sendEvent('grant coupon entitlements for purchase', {
			name: GRANT_COUPON_ENTITLEMENTS_FOR_PURCHASE_EVENT,
			data: {
				purchaseId: purchase.id,
				userId: purchase.userId || user.id,
				productId: purchase.productId,
				purchaseStatus: purchase.status,
				totalAmount: purchase.totalAmount,
				bulkCouponId: purchase.bulkCouponId,
			},
		})

		await tracePostPurchase('coupon_entitlement_event.sent', traceBase)

		// Step 6: Mark entitlement-based coupons as used (set deletedAt) if they were used in this checkout
		// Note: Entitlement coupons are only used in real Stripe checkout sessions (NEW_PURCHASE_CREATED_EVENT).
		// Full-price coupon redemptions (FULL_PRICE_COUPON_REDEEMED_EVENT) don't use entitlement coupons.
		await step.run('mark entitlement coupons as used', async () => {
			if (event.name === FULL_PRICE_COUPON_REDEEMED_EVENT) {
				return {
					marked: 0,
					reason: 'Coupon redemption - no entitlement coupons to process',
				}
			}

			const checkoutSessionId = event.data.checkoutSessionId
			if (!checkoutSessionId || !purchase.userId) {
				return { marked: 0, reason: 'No checkout session ID or user ID' }
			}

			if (!paymentProvider) {
				return { marked: 0, reason: 'No payment provider available' }
			}

			let checkoutSession
			try {
				checkoutSession =
					await paymentProvider.options.paymentsAdapter.getCheckoutSession(
						checkoutSessionId,
					)
			} catch (error: any) {
				await log.warn('checkout.session.not_found', {
					checkoutSessionId,
					purchaseId: purchase.id,
					userId: purchase.userId,
					eventName: event.name,
					error: error.message,
				})
				return {
					marked: 0,
					reason: 'Checkout session not found',
				}
			}

			const usedEntitlementCouponIds: string | undefined =
				checkoutSession.metadata?.usedEntitlementCouponIds

			if (!usedEntitlementCouponIds) {
				return { marked: 0, reason: 'No entitlement coupons used' }
			}

			const couponIds = usedEntitlementCouponIds
				.split(',')
				.map((id) => id.trim())
				.filter((id) => id.length > 0)

			if (couponIds.length === 0) {
				return { marked: 0, reason: 'No valid coupon IDs' }
			}

			const specialCreditEntitlementType =
				await db.query.entitlementTypes.findFirst({
					where: eq(entitlementTypes.name, 'apply_special_credit'),
				})

			if (!specialCreditEntitlementType) {
				return { marked: 0, reason: 'Entitlement type not found' }
			}

			const result = await db
				.update(entitlements)
				.set({ deletedAt: new Date() })
				.where(
					and(
						eq(entitlements.userId, purchase.userId),
						eq(entitlements.entitlementType, specialCreditEntitlementType.id),
						eq(entitlements.sourceType, EntitlementSourceType.COUPON),
						sql`${entitlements.sourceId} IN (${sql.join(
							couponIds.map((id) => sql`${id}`),
							sql`, `,
						)})`,
						isNull(entitlements.deletedAt),
					),
				)

			return {
				marked: result.rowsAffected || 0,
				couponIds,
			}
		})

		// Step 7: Get bulk coupon data if needed
		const bulkCouponData = await step.run(`get bulk coupon data`, async () => {
			if (isFullPriceCouponRedemption && purchase.redeemedBulkCouponId) {
				const couponWithBulkPurchases =
					await adapter.getCouponWithBulkPurchases(
						purchase.redeemedBulkCouponId,
					)

				// The original bulk purchase should be in the bulkPurchases array
				const originalBulkPurchase = couponWithBulkPurchases?.bulkPurchases?.[0]

				return {
					coupon: couponWithBulkPurchases,
					originalBulkPurchase,
				}
			}
			return null
		})

		if (product.type === ARCHIVE_PRODUCT_TYPE) {
			if (!['Valid', 'Restricted'].includes(purchase.status)) {
				return {
					purchase,
					product,
					user,
					resourceContexts: [],
					isTeamPurchase,
					isFullPriceCouponRedemption,
					bulkCouponData,
					archive: {
						skipped: `purchase status ${purchase.status} is not fulfillable`,
					},
				}
			}

			const archivePolicy = getArchiveProductPolicy(product)

			await step.run('persist archive policy snapshot', async () => {
				return persistArchivePolicySnapshot({
					purchaseId: purchase.id,
					policy: archivePolicy,
				})
			})

			const { organizationId, orgMembership } = await step.run(
				'ensure archive entitlement context',
				async () => {
					return ensureArchiveEntitlementContext({
						purchase,
						user,
					})
				},
			)

			const archiveResult = await step.run(
				'reconcile archive entitlements for purchase',
				async () => {
					return reconcileArchivePurchaseEntitlements({
						purchase,
						product,
						user,
						organizationId,
						organizationMembershipId: orgMembership.id,
						asOf: new Date(purchase.createdAt),
					})
				},
			)

			await step.run('log archive fulfillment', async () => {
				await log.info('archive_purchase.fulfilled', {
					purchaseId: purchase.id,
					productId: product.id,
					productName: product.name,
					userId: user.id,
					email: user.email,
					organizationId,
					organizationMembershipId: orgMembership.id,
					grantedCount: archiveResult.granted.length,
					removedCount: archiveResult.removed.length,
					newAccessCount: archiveResult.granted.filter((g) => g.isNewAccess)
						.length,
					eligibleCohortCount: archiveResult.eligibleCohortCount,
					targetResourceCount: archiveResult.targetResourceCount,
					expiresAt: archiveResult.expiresAt,
					policy: archiveResult.policy,
					grantedCohortIds: [
						...new Set(archiveResult.granted.map((g) => g.cohortId)),
					],
					grantedResourceIds: archiveResult.granted.map((g) => g.resourceId),
					isTeamPurchase,
					isFullPriceCouponRedemption,
				})
			})

			// Send archive welcome email
			const newAccessGrants = archiveResult.granted.filter((g) => g.isNewAccess)
			if (newAccessGrants.length > 0) {
				await step.run('send archive welcome email', async () => {
					const workshops = newAccessGrants.map((g) => ({
						title: g.workshopTitle ?? g.resourceId,
						slug: g.workshopSlug ?? '',
						cohortTitle: g.cohortTitle ?? g.cohortId,
					}))

					const uniqueCohortIds = new Set(
						newAccessGrants.map((g) => g.cohortId),
					)

					await sendAnEmail({
						Component: WelcomeArchiveEmail,
						componentProps: {
							productName: product.name,
							userFirstName: user.name?.split(' ')[0],
							workshops,
							expiresAt: archiveResult.expiresAt,
							cohortCount: uniqueCohortIds.size,
						},
						Subject: `Welcome to ${product.name}!`,
						To: user.email,
						ReplyTo: env.NEXT_PUBLIC_SUPPORT_EMAIL,
						From: env.NEXT_PUBLIC_SUPPORT_EMAIL,
						type: 'transactional',
					})

					await log.info('archive_purchase.welcome_email_sent', {
						purchaseId: purchase.id,
						productId: product.id,
						productName: product.name,
						userId: user.id,
						email: user.email,
						workshopCount: workshops.length,
						cohortCount: uniqueCohortIds.size,
						cohortIds: [...uniqueCohortIds],
						workshopSlugs: workshops.map((w) => w.slug),
						expiresAt: archiveResult.expiresAt,
					})
				})
			}

			return {
				purchase,
				product,
				user,
				resourceContexts: [],
				isTeamPurchase,
				isFullPriceCouponRedemption,
				bulkCouponData,
				archive: archiveResult,
			}
		}

		const nonArchiveProductType = productType as ProductType

		// Step 8: Gather all resource contexts from the product
		await tracePostPurchase('resource_contexts.gathering', traceBase)

		const resourceContexts = await step.run(
			`gather all resource contexts`,
			async () => {
				return gatherResourceContexts(product, nonArchiveProductType)
			},
		)

		await tracePostPurchase('resource_contexts.gathered', {
			...traceBase,
			resourceContextsCount: resourceContexts.length,
			resourceContexts: resourceContexts.map((context) => ({
				resourceId: context.resourceId,
				resourceType: context.resourceType,
				productType: context.productType,
				workshopAvailabilityCounts: context.workshopAvailability
					? {
							availableNow: context.workshopAvailability.availableNow.length,
							upcoming: context.workshopAvailability.upcoming.length,
						}
					: null,
			})),
		})

		if (resourceContexts.length === 0) {
			throw new Error(`No resources found for product`)
		}

		// Step 9: Load full resource data for each context
		await tracePostPurchase('resource_data.loading', traceBase)

		const resourceDataMap = await step.run(
			`load resource data for all contexts`,
			async () => {
				const dataMap: Record<string, any> = {}
				for (const context of resourceContexts) {
					const resourceData = await getResourceData(
						context.resourceId,
						context.productType,
					)
					dataMap[context.resourceId] = resourceData
				}
				return dataMap
			},
		)

		await tracePostPurchase('resource_data.loaded', {
			...traceBase,
			resourceDataCount: Object.keys(resourceDataMap).length,
		})

		// Step 10: Handle team purchases
		if (isTeamPurchase) {
			const bulkCoupon = await step.run('get bulk coupon', async () => {
				if (purchase.bulkCouponId) {
					return adapter.getCoupon(purchase.bulkCouponId)
				}
				return null
			})

			// Send welcome email for each resource context
			for (const context of resourceContexts) {
				const resourceData = resourceDataMap[context.resourceId]
				if (!resourceData) continue

				const resourceConfig = PRODUCT_TYPE_CONFIG[context.productType]
				if (!resourceConfig) continue

				await step.run(
					`send welcome email to team purchaser for ${context.resourceType}`,
					async () => {
						const parsedResource = ContentResourceSchema.parse(resourceData)
						const contentUrl = generateContentUrl(
							parsedResource,
							context.productType,
							context.workshopAvailability,
						)

						if (context.productType === 'cohort') {
							await sendAnEmail({
								Component: WelcomeCohortEmailForTeam,
								componentProps: {
									cohortTitle:
										parsedResource.fields?.title || parsedResource.fields?.slug,
									url: contentUrl,
									availableNow:
										context.workshopAvailability?.availableNow || [],
									upcoming: context.workshopAvailability?.upcoming || [],
									quantity: bulkCoupon?.maxUses || 1,
									userFirstName: user.name?.split(' ')[0],
								},
								Subject: `Welcome to ${parsedResource.fields?.title || config.defaultTitle}!`,
								To: user.email,
								ReplyTo: env.NEXT_PUBLIC_SUPPORT_EMAIL,
								From: env.NEXT_PUBLIC_SUPPORT_EMAIL,
								type: 'transactional',
							})
						} else {
							await sendAnEmail({
								Component: WelcomeWorkshopEmailForTeam,
								componentProps: {
									workshopTitle:
										parsedResource.fields?.title || parsedResource.fields?.slug,
									url: contentUrl,
									quantity: bulkCoupon?.maxUses || 1,
									userFirstName: user.name?.split(' ')[0],
								},
								Subject: `Welcome to ${parsedResource.fields?.title || config.defaultTitle}!`,
								To: user.email,
								ReplyTo: env.NEXT_PUBLIC_SUPPORT_EMAIL,
								From: env.NEXT_PUBLIC_SUPPORT_EMAIL,
								type: 'transactional',
							})
						}

						await log.info(`${resourceConfig.logPrefix}_welcome_email.sent`, {
							purchaseId: purchase.id,
							resourceId: context.resourceId,
							resourceType: context.resourceType,
							productType: context.productType,
							emailType: 'team_purchaser',
						})
					},
				)
			}

			// Handle commented out live office hours logic
			if (isFullPriceCouponRedemption) {
				// Future: Live office hours invitation logic
			}
		} else {
			// Step 11: Handle individual purchases
			if (['Valid', 'Restricted'].includes(purchase.status)) {
				// Ensure organization membership (shared across all resources)
				await tracePostPurchase('org_membership.ensuring', {
					...traceBase,
					userId: user.id,
					purchaseOrganizationId: purchase.organizationId,
					isFullPriceCouponRedemption,
				})

				const { organizationId, orgMembership } = await step.run(
					`ensure org membership`,
					async () => {
						// Determine who invited this user - for full price coupon redemptions,
						// it should be the original bulk purchaser
						const invitedById =
							isFullPriceCouponRedemption &&
							bulkCouponData?.originalBulkPurchase?.userId
								? bulkCouponData.originalBulkPurchase.userId
								: user.id

						// Use the organization from purchase if available, otherwise ensure personal org
						if (purchase.organizationId) {
							const orgMembership = await adapter.addMemberToOrganization({
								organizationId: purchase.organizationId,
								userId: user.id,
								invitedById,
							})

							if (!orgMembership) {
								throw new Error(`orgMembership is required`)
							}

							await adapter.addRoleForMember({
								organizationId: purchase.organizationId,
								memberId: orgMembership.id,
								role: 'learner',
							})

							return {
								organizationId: purchase.organizationId,
								orgMembership,
							}
						} else {
							// No organizationId on purchase - ensure user has personal org
							const personalOrgResult =
								await ensurePersonalOrganizationWithLearnerRole(user, adapter)

							return {
								organizationId: personalOrgResult.organization.id,
								orgMembership: personalOrgResult.membership,
							}
						}
					},
				)

				await tracePostPurchase('org_membership.ensured', {
					...traceBase,
					userId: user.id,
					organizationId,
					organizationMembershipId: orgMembership.id,
				})

				// Process each resource context
				for (const context of resourceContexts) {
					const resourceData = resourceDataMap[context.resourceId]
					if (!resourceData) {
						await tracePostPurchase('resource_context.skipped_missing_data', {
							...traceBase,
							resourceId: context.resourceId,
							resourceType: context.resourceType,
							resourceProductType: context.productType,
						})
						continue
					}

					const resourceConfig = PRODUCT_TYPE_CONFIG[context.productType]
					if (!resourceConfig) {
						await tracePostPurchase('resource_context.skipped_missing_config', {
							...traceBase,
							resourceId: context.resourceId,
							resourceType: context.resourceType,
							resourceProductType: context.productType,
						})
						continue
					}

					await tracePostPurchase('resource_context.started', {
						...traceBase,
						resourceId: context.resourceId,
						resourceType: context.resourceType,
						resourceProductType: context.productType,
					})

					// Get entitlement types for this resource's product type
					const contentAccessEntitlementType = await step.run(
						`get ${resourceConfig.logPrefix} content access entitlement type for ${context.resourceId}`,
						async () => {
							return await db.query.entitlementTypes.findFirst({
								where: eq(entitlementTypes.name, resourceConfig.contentAccess),
							})
						},
					)

					const discordRoleEntitlementType = await step.run(
						`get ${resourceConfig.logPrefix} discord role entitlement type for ${context.resourceId}`,
						async () => {
							return await db.query.entitlementTypes.findFirst({
								where: eq(entitlementTypes.name, resourceConfig.discordRole),
							})
						},
					)

					if (!contentAccessEntitlementType) {
						await tracePostPurchase(
							'resource_context.skipped_missing_content_entitlement_type',
							{
								...traceBase,
								resourceId: context.resourceId,
								resourceType: context.resourceType,
								resourceProductType: context.productType,
							},
						)
						continue
					}

					// Determine which product to use for Discord role ID
					// Prefer the resource's own product, fallback to purchased product
					const productForDiscord = context.productForResource || product
					const discordRoleId = getDiscordRoleId(
						context.productType,
						productForDiscord,
					)

					// Discord role assignment is async. It should never delay core access.
					await step.sendEvent(
						`request discord role for ${context.resourceId}`,
						{
							name: POST_PURCHASE_DISCORD_ROLE_REQUESTED_EVENT,
							data: {
								purchaseId: purchase.id,
								userId: user.id,
								organizationId,
								organizationMembershipId: orgMembership.id,
								resourceId: context.resourceId,
								resourceType: context.resourceType,
								resourceProductType: context.productType,
								resourceDataId: resourceData.id,
								discordRoleId,
								discordRoleEntitlementTypeId:
									discordRoleEntitlementType?.id ?? null,
							},
						},
					)

					await tracePostPurchase('discord_role_event.requested', {
						...traceBase,
						userId: user.id,
						resourceId: context.resourceId,
						resourceType: context.resourceType,
						resourceProductType: context.productType,
						discordRoleId,
					})

					// Create content access entitlements
					await tracePostPurchase('content_entitlements.creating', {
						...traceBase,
						userId: user.id,
						resourceId: context.resourceId,
						resourceType: context.resourceType,
						resourceProductType: context.productType,
					})

					await step.run(
						`add user to ${resourceConfig.logPrefix} via entitlement for ${context.resourceId}`,
						async () => {
							const createdEntitlements = await createResourceEntitlements(
								context.productType,
								resourceData,
								{
									user,
									purchase,
									organizationId,
									orgMembership,
									contentAccessEntitlementType,
								},
							)

							await log.info(
								`${resourceConfig.logPrefix}_entitlements_created`,
								{
									userId: user.id,
									resourceId: context.resourceId,
									resourceType: context.resourceType,
									productType: context.productType,
									[`${resourceConfig.logPrefix}Id`]: resourceData.id,
									entitlementsCreated: createdEntitlements.length,
									organizationId,
									organizationMembershipId: orgMembership.id,
								},
							)

							return {
								entitlementsCreated: createdEntitlements.length,
								entitlements: createdEntitlements,
								organizationId,
								organizationMembershipId: orgMembership.id,
								userId: user.id,
								resourceId: context.resourceId,
							}
						},
					)

					await tracePostPurchase('content_entitlements.created', {
						...traceBase,
						userId: user.id,
						resourceId: context.resourceId,
						resourceType: context.resourceType,
						resourceProductType: context.productType,
					})

					// Redeemed Seat Purchase welcome emails are owned by Team Seat Redemption Followup.
					if (isFullPriceCouponRedemption) {
						await tracePostPurchase('welcome_email.skipped', {
							...traceBase,
							userId: user.id,
							resourceId: context.resourceId,
							resourceType: context.resourceType,
							resourceProductType: context.productType,
							reason: 'owned_by_team_seat_redemption_followup',
						})
					} else {
						await step.sendEvent(
							`request welcome email for ${context.resourceId}`,
							{
								name: POST_PURCHASE_WELCOME_EMAIL_REQUESTED_EVENT,
								data: {
									purchaseId: purchase.id,
									userId: user.id,
									userEmail: user.email,
									userFirstName: user.name?.split(' ')[0],
									resourceId: context.resourceId,
									resourceType: context.resourceType,
									resourceProductType: context.productType,
									resourceData,
									workshopAvailability: context.workshopAvailability,
								},
							},
						)

						await tracePostPurchase('welcome_email.requested', {
							...traceBase,
							userId: user.id,
							resourceId: context.resourceId,
							resourceType: context.resourceType,
							resourceProductType: context.productType,
						})
					}

					await tracePostPurchase('resource_context.completed', {
						...traceBase,
						userId: user.id,
						resourceId: context.resourceId,
						resourceType: context.resourceType,
						resourceProductType: context.productType,
					})
				}

				await tracePostPurchase('individual_purchase_fulfillment.completed', {
					...traceBase,
					userId: user.id,
					resourceContextsCount: resourceContexts.length,
				})

				// Future: Live office hours email logic
			} else {
				// send a slack message or something because it seems broken
			}
		}

		if (productType === 'cohort') {
			await tracePostPurchase('legend_role_event.sending', {
				...traceBase,
				userId: user.id,
			})

			await step.sendEvent('grant legend discord role', {
				name: GRANT_LEGEND_DISCORD_ROLE_EVENT,
				data: {
					purchaseId: purchase.id,
					userId: user.id,
				},
			})

			await tracePostPurchase('legend_role_event.sent', {
				...traceBase,
				userId: user.id,
			})
		}

		await tracePostPurchase('workflow.completed', {
			...traceBase,
			userId: user.id,
			durationMs: Date.now() - workflowStartedAt,
			resourceContextsCount: resourceContexts.length,
		})

		return {
			purchase,
			product,
			user,
			resourceContexts,
			isTeamPurchase,
			isFullPriceCouponRedemption,
			bulkCouponData,
		}
	},
)
