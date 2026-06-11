import NewArchiveContentEmail from '@/emails/new-archive-content-email'
import { env } from '@/env.mjs'
import { inngest } from '@/inngest/inngest.server'
import {
	computeArchivePurchaseExpiresAt,
	ensureArchiveEntitlementContext,
	getActiveArchivePurchases,
	getArchivePolicyForPurchase,
	reconcileArchivePurchaseEntitlements,
} from '@/lib/archive-products'
import { log } from '@/server/logger'
import { sendAnEmail } from '@coursebuilder/utils/send-an-email'

export const archivePurchaseReconciliation = inngest.createFunction(
	{
		id: 'archive-purchase-reconciliation',
		name: 'Archive Purchase Reconciliation',
		concurrency: {
			limit: 1,
		},
	},
	{
		cron: 'TZ=UTC 15 5 * * *',
	},
	async ({ step }) => {
		const startedAt = Date.now()

		const activeArchivePurchases = await step.run(
			'load active archive purchases',
			async () => {
				return getActiveArchivePurchases()
			},
		)

		const results: Array<{
			purchaseId: string
			grantedCount: number
			removedCount: number
			targetResourceCount: number
			newAccessCount: number
		}> = []
		const errors: Array<{ purchaseId: string; error: string }> = []

		for (const archivePurchase of activeArchivePurchases) {
			try {
				const context = await step.run(
					`ensure entitlement context ${archivePurchase.id}`,
					async () => {
						return ensureArchiveEntitlementContext({
							purchase: archivePurchase,
							user: archivePurchase.user,
						})
					},
				)

				const reconciliation = await step.run(
					`reconcile archive purchase ${archivePurchase.id}`,
					async () => {
						return reconcileArchivePurchaseEntitlements({
							purchase: archivePurchase,
							product: archivePurchase.product,
							user: archivePurchase.user,
							organizationId: context.organizationId,
							organizationMembershipId: context.orgMembership.id,
						})
					},
				)

				// Send notification email only for genuinely new access
				const newAccessGrants = reconciliation.granted.filter(
					(g) => g.isNewAccess,
				)
				if (newAccessGrants.length > 0) {
					await step.run(
						`send new content email ${archivePurchase.id}`,
						async () => {
							const workshops = newAccessGrants.map((g) => ({
								title: g.workshopTitle ?? g.resourceId,
								slug: g.workshopSlug ?? '',
								cohortTitle: g.cohortTitle ?? g.cohortId,
							}))

							const uniqueCohortIds = new Set(
								newAccessGrants.map((g) => g.cohortId),
							)

							const policy = getArchivePolicyForPurchase({
								purchase: archivePurchase,
								product: archivePurchase.product,
							})
							const expiresAt = computeArchivePurchaseExpiresAt(
								archivePurchase.createdAt,
								policy.accessDurationDays,
							)

							await sendAnEmail({
								Component: NewArchiveContentEmail,
								componentProps: {
									productName:
										archivePurchase.product.fields?.name ??
										'AI Hero Catalog Access',
									userFirstName: archivePurchase.user.name?.split(' ')[0],
									workshops,
									cohortCount: uniqueCohortIds.size,
									expiresAt: expiresAt.toISOString(),
								},
								Subject: `New workshops just landed in your archive!`,
								To: archivePurchase.user.email,
								ReplyTo: env.NEXT_PUBLIC_SUPPORT_EMAIL,
								From: env.NEXT_PUBLIC_SUPPORT_EMAIL,
								type: 'transactional',
							})

							await log.info('archive_purchase.new_content_email_sent', {
								purchaseId: archivePurchase.id,
								userId: archivePurchase.user.id,
								email: archivePurchase.user.email,
								productId: archivePurchase.product.id,
								workshopCount: workshops.length,
								cohortCount: uniqueCohortIds.size,
								cohortIds: [...uniqueCohortIds],
								workshopSlugs: workshops.map((w) => w.slug),
							})
						},
					)
				}

				if (
					reconciliation.granted.length > 0 ||
					reconciliation.removed.length > 0
				) {
					await log.info('archive_purchase.reconciled', {
						purchaseId: archivePurchase.id,
						userId: archivePurchase.user.id,
						email: archivePurchase.user.email,
						productId: archivePurchase.product.id,
						grantedCount: reconciliation.granted.length,
						removedCount: reconciliation.removed.length,
						newAccessCount: newAccessGrants.length,
						targetResourceCount: reconciliation.targetResourceCount,
						eligibleCohortCount: reconciliation.eligibleCohortCount,
						expiresAt: reconciliation.expiresAt,
						grantedResourceIds: reconciliation.granted.map((g) => g.resourceId),
						removedResourceIds: reconciliation.removed.map((r) => r.resourceId),
						policy: reconciliation.policy,
					})
				}

				results.push({
					purchaseId: archivePurchase.id,
					grantedCount: reconciliation.granted.length,
					removedCount: reconciliation.removed.length,
					targetResourceCount: reconciliation.targetResourceCount,
					newAccessCount: newAccessGrants.length,
				})
			} catch (error) {
				await log.error('archive_purchase.reconciliation_failed', {
					purchaseId: archivePurchase.id,
					userId: archivePurchase.user.id,
					email: archivePurchase.user.email,
					productId: archivePurchase.product.id,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				})

				errors.push({
					purchaseId: archivePurchase.id,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}

		await log.info('archive_purchase.reconciliation_completed', {
			purchaseCount: activeArchivePurchases.length,
			successful: results.length,
			failed: errors.length,
			duration: Date.now() - startedAt,
			errors,
		})

		return {
			purchaseCount: activeArchivePurchases.length,
			results,
			errors,
		}
	},
)
