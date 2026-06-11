import config from '@/config'
import { courseBuilderAdapter, db } from '@/db'
import {
	contentResource,
	contentResourceProduct,
	contentResourceResource,
	coupon,
	entitlementTypes,
	products,
	purchases,
	users,
} from '@/db/schema'
import BasicEmail from '@/emails/basic-email'
import WelcomeCohortEmailForTeamRedeemer from '@/emails/welcome-cohort-email-team-redeemer'
import { env } from '@/env.mjs'
import { getWorkshopAvailability } from '@/lib/get-workshop-availability'
import { ensurePersonalOrganizationWithLearnerRole } from '@/lib/personal-organization-service'
import { createResourceEntitlements } from '@/lib/entitlements-query'
import {
	alertPurchaseBenefitOperator,
	logPurchaseBenefitReceipt,
} from '@/lib/purchase-benefit-telemetry'
import { log } from '@/server/logger'
import { sendAnEmail } from '@coursebuilder/utils/send-an-email'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import { ContentResourceSchema } from '@coursebuilder/core/schemas'

export type ExpandedPurchaseBenefit = {
	id: string
	type: string
	appliesTo: string
	resourceType: string
	resourceId: string
	welcomeEmailResourceId?: string
	source?: Record<string, unknown>
}

export type PurchaseBenefitEntitlementResult = {
	purchaseBenefitId: string
	status: 'applied' | 'skipped'
	reason?: string
	entitlementIds: string[]
	resourceId: string
	resourceType: string
}

type BenefitSource = 'buyer_purchase' | 'team_seat_redemption'

export async function applyPurchaseBenefitEntitlements(input: {
	operationalPurchaseId: string
	userId: string
	benefits: ExpandedPurchaseBenefit[]
	source: BenefitSource
}): Promise<PurchaseBenefitEntitlementResult[]> {
	const purchase = await db.query.purchases!.findFirst({
		where: eq(purchases.id, input.operationalPurchaseId),
	})

	if (!purchase) throw new Error('purchase not found')
	if (purchase.userId !== input.userId)
		throw new Error('purchase user mismatch')

	const user = await db.query.users!.findFirst({
		where: eq(users.id, input.userId),
	})

	if (!user) throw new Error('user not found')

	const contentAccessEntitlementType =
		await db.query.entitlementTypes!.findFirst({
			where: eq(entitlementTypes.name, 'cohort_content_access'),
		})

	if (!contentAccessEntitlementType) {
		throw new Error('cohort_content_access entitlement type not found')
	}

	const { organization, membership } =
		await ensurePersonalOrganizationWithLearnerRole(
			user as any,
			courseBuilderAdapter,
		)

	const results: PurchaseBenefitEntitlementResult[] = []

	for (const benefit of input.benefits) {
		if (benefit.type !== 'access') {
			await alertPurchaseBenefitOperator({
				event: 'purchase_benefit.unsupported_benefit_type',
				title: 'Purchase Benefit needs review',
				message: `Unsupported Purchase Benefit type: ${benefit.type}`,
				envelope: {
					purchaseBenefitId: benefit.id,
					purchaseId: purchase.id,
					userId: user.id,
					userEmail: user.email,
					productId: purchase.productId,
					resourceId: benefit.resourceId,
					resourceType: benefit.resourceType,
					reason: 'unsupported-benefit-type',
				},
			})
			results.push({
				purchaseBenefitId: benefit.id,
				status: 'skipped',
				reason: 'unsupported-benefit-type',
				entitlementIds: [],
				resourceId: benefit.resourceId,
				resourceType: benefit.resourceType,
			})
			continue
		}

		if (benefit.resourceType !== 'cohort') {
			await alertPurchaseBenefitOperator({
				event: 'purchase_benefit.unsupported_resource_type',
				title: 'Purchase Benefit resource needs review',
				message: `Unsupported Purchase Benefit resource type: ${benefit.resourceType}`,
				envelope: {
					purchaseBenefitId: benefit.id,
					purchaseId: purchase.id,
					userId: user.id,
					userEmail: user.email,
					productId: purchase.productId,
					resourceId: benefit.resourceId,
					resourceType: benefit.resourceType,
					reason: 'unsupported-resource-type',
				},
			})
			results.push({
				purchaseBenefitId: benefit.id,
				status: 'skipped',
				reason: 'unsupported-resource-type',
				entitlementIds: [],
				resourceId: benefit.resourceId,
				resourceType: benefit.resourceType,
			})
			continue
		}

		const cohort = await db.query.contentResource!.findFirst({
			where: and(
				eq(contentResource.id, benefit.resourceId),
				eq(contentResource.type, 'cohort'),
				isNull(contentResource.deletedAt),
			),
			with: {
				resources: {
					with: { resource: true },
					orderBy: [asc(contentResourceResource.position)],
				},
			},
		})

		if (!cohort) {
			await alertPurchaseBenefitOperator({
				event: 'purchase_benefit.resource_not_found',
				title: 'Purchase Benefit cohort is missing',
				message: `Could not find cohort resource ${benefit.resourceId} for Purchase Benefit ${benefit.id}.`,
				envelope: {
					purchaseBenefitId: benefit.id,
					purchaseId: purchase.id,
					userId: user.id,
					userEmail: user.email,
					productId: purchase.productId,
					resourceId: benefit.resourceId,
					resourceType: benefit.resourceType,
					reason: 'resource-not-found',
				},
			})
			results.push({
				purchaseBenefitId: benefit.id,
				status: 'skipped',
				reason: 'resource-not-found',
				entitlementIds: [],
				resourceId: benefit.resourceId,
				resourceType: benefit.resourceType,
			})
			continue
		}

		let created: Array<{ entitlementId: string }>
		try {
			created = await createResourceEntitlements('cohort', cohort, {
				user,
				purchase,
				organizationId: organization.id,
				orgMembership: membership,
				contentAccessEntitlementType,
				metadata: {
					purchaseBenefit: true,
					purchaseBenefitId: benefit.id,
					purchaseBenefitSource: input.source,
					purchaseBenefitAppliesTo: benefit.appliesTo,
					purchaseBenefitResourceType: benefit.resourceType,
					purchaseBenefitResourceId: benefit.resourceId,
				},
			})
		} catch (error) {
			await alertPurchaseBenefitOperator({
				event: 'purchase_benefit.entitlement_creation_failed',
				title: 'Purchase Benefit entitlement failed',
				message: `Entitlement creation failed for Purchase Benefit ${benefit.id}.`,
				severity: 'error',
				envelope: {
					purchaseBenefitId: benefit.id,
					purchaseId: purchase.id,
					userId: user.id,
					userEmail: user.email,
					productId: purchase.productId,
					resourceId: benefit.resourceId,
					resourceType: benefit.resourceType,
					reason: error instanceof Error ? error.message : String(error),
				},
			})
			throw error
		}

		await logPurchaseBenefitReceipt('purchase_benefit.entitlements_applied', {
			purchaseId: purchase.id,
			userId: user.id,
			purchaseBenefitId: benefit.id,
			resourceId: benefit.resourceId,
			resourceType: benefit.resourceType,
			entitlementsCreated: created.length,
			source: input.source,
		})

		results.push({
			purchaseBenefitId: benefit.id,
			status: created.length > 0 ? 'applied' : 'skipped',
			reason: created.length > 0 ? undefined : 'active-entitlement-exists',
			entitlementIds: created.map((entitlement) => entitlement.entitlementId),
			resourceId: benefit.resourceId,
			resourceType: benefit.resourceType,
		})
	}

	return results
}

export async function getBuyerPurchaseBenefits(purchaseId: string) {
	const purchase = await db.query.purchases!.findFirst({
		where: eq(purchases.id, purchaseId),
	})

	return {
		purchase,
		benefits: ((purchase?.fields as any)?.purchaseBenefits ??
			[]) as ExpandedPurchaseBenefit[],
	}
}

export async function getTeamSeatPurchaseBenefits(input: {
	redeemedPurchaseId: string
	bulkCouponId: string
}) {
	const redeemedPurchase = await db.query.purchases!.findFirst({
		where: eq(purchases.id, input.redeemedPurchaseId),
	})
	const bulkCoupon = await db.query.coupon!.findFirst({
		where: eq(coupon.id, input.bulkCouponId),
	})

	return {
		redeemedPurchase,
		bulkCoupon,
		benefits: ((bulkCoupon?.fields as any)?.purchaseBenefits ??
			[]) as ExpandedPurchaseBenefit[],
	}
}

type WelcomeEmailSource = 'buyer_purchase' | 'team_seat_redemption'

type WelcomeEmailResult =
	| { status: 'sent'; marker: string; welcomeEmailResourceId?: string }
	| { status: 'skipped'; reason: string }
	| { status: 'review'; reason: string; welcomeEmailResourceIds: string[] }

function uniqueWelcomeEmailResourceIds(benefits: ExpandedPurchaseBenefit[]) {
	return Array.from(
		new Set(
			benefits
				.map((benefit) => benefit.welcomeEmailResourceId)
				.filter((id): id is string => Boolean(id)),
		),
	)
}

function mergePurchaseFields(
	fields: unknown,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	return {
		...((fields ?? {}) as Record<string, unknown>),
		...patch,
	}
}

async function markPurchaseFields(
	purchaseId: string,
	fields: unknown,
	patch: Record<string, unknown>,
) {
	const nextFields = mergePurchaseFields(fields, patch)
	await db
		.update(purchases)
		.set({ fields: nextFields })
		.where(eq(purchases.id, purchaseId))
	return nextFields
}

async function claimWelcomeEmailSend(input: {
	purchaseId: string
	fields: unknown
	sentField: string
	sendingField: string
	patch: Record<string, unknown>
}) {
	const nextFields = mergePurchaseFields(input.fields, input.patch)
	const result = await db
		.update(purchases)
		.set({ fields: nextFields })
		.where(
			and(
				eq(purchases.id, input.purchaseId),
				sql`JSON_EXTRACT(${purchases.fields}, ${`$.${input.sentField}`}) IS NULL`,
				sql`JSON_EXTRACT(${purchases.fields}, ${`$.${input.sendingField}`}) IS NULL`,
			),
		)

	return result.rowsAffected && result.rowsAffected > 0 ? nextFields : null
}

async function getBenefitTitles(benefits: ExpandedPurchaseBenefit[]) {
	const titles: string[] = []

	for (const benefit of benefits) {
		if (benefit.resourceType !== 'cohort') continue

		const resource = await db.query.contentResource!.findFirst({
			where: and(
				eq(contentResource.id, benefit.resourceId),
				eq(contentResource.type, 'cohort'),
				isNull(contentResource.deletedAt),
			),
		})

		const title =
			(resource?.fields as any)?.title ?? (resource?.fields as any)?.slug
		if (title) titles.push(title)
	}

	return titles
}

async function loadBespokeWelcomeEmail(resourceId: string) {
	return db.query.contentResource!.findFirst({
		where: and(
			eq(contentResource.id, resourceId),
			eq(contentResource.type, 'email'),
			isNull(contentResource.deletedAt),
		),
	})
}

export async function sendBuyerPurchaseBenefitWelcomeEmail(input: {
	purchaseId: string
	benefits: ExpandedPurchaseBenefit[]
	applicationResults: PurchaseBenefitEntitlementResult[]
}): Promise<WelcomeEmailResult> {
	const { purchase } = await getBuyerPurchaseBenefits(input.purchaseId)
	if (!purchase) throw new Error('purchase not found')
	if (!purchase.userId) throw new Error('purchase missing user')

	const fields = (purchase.fields ?? {}) as Record<string, any>
	if (fields.purchaseBenefitWelcomeEmailSentAt) {
		return { status: 'skipped', reason: 'already-sent' }
	}
	if (fields.purchaseBenefitWelcomeEmailSendingAt) {
		return { status: 'skipped', reason: 'send-already-claimed' }
	}

	const welcomeEmailResourceIds = uniqueWelcomeEmailResourceIds(input.benefits)
	if (welcomeEmailResourceIds.length > 1) {
		await markPurchaseFields(purchase.id, fields, {
			purchaseBenefitWelcomeEmailReview: {
				state: 'needs_review',
				reason: 'conflicting-welcome-email-resources',
				welcomeEmailResourceIds,
				updatedAt: new Date().toISOString(),
			},
		})
		await alertPurchaseBenefitOperator({
			event: 'purchase_benefit.welcome_email.conflicting_resources',
			title: 'Purchase Benefit welcome email conflict',
			message:
				'Multiple distinct welcome email resources were configured for one buyer benefit followup.',
			envelope: {
				purchaseId: purchase.id,
				userId: purchase.userId,
				welcomeEmailResourceId: welcomeEmailResourceIds.join(','),
				reason: 'conflicting-welcome-email-resources',
			},
		})
		return {
			status: 'review',
			reason: 'conflicting-welcome-email-resources',
			welcomeEmailResourceIds,
		}
	}

	const user = await db.query.users!.findFirst({
		where: eq(users.id, purchase.userId as string),
	})
	if (!user?.email) throw new Error('user missing email')

	const benefitTitles = await getBenefitTitles(input.benefits)
	const bespokeEmail = welcomeEmailResourceIds[0]
		? await loadBespokeWelcomeEmail(welcomeEmailResourceIds[0])
		: null
	if (welcomeEmailResourceIds[0] && !bespokeEmail) {
		await alertPurchaseBenefitOperator({
			event: 'purchase_benefit.welcome_email.resource_not_found',
			title: 'Purchase Benefit welcome email is missing',
			message: `Could not find welcome email resource ${welcomeEmailResourceIds[0]}.`,
			envelope: {
				purchaseId: purchase.id,
				userId: purchase.userId,
				welcomeEmailResourceId: welcomeEmailResourceIds[0],
				reason: 'welcome-email-resource-not-found',
			},
		})
	}
	const bespokeFields = (bespokeEmail?.fields ?? {}) as Record<string, any>
	const sendingAt = new Date().toISOString()
	const claimedFields = await claimWelcomeEmailSend({
		purchaseId: purchase.id,
		fields,
		sentField: 'purchaseBenefitWelcomeEmailSentAt',
		sendingField: 'purchaseBenefitWelcomeEmailSendingAt',
		patch: {
			purchaseBenefitWelcomeEmailSendingAt: sendingAt,
			purchaseBenefitWelcomeEmailResourceId: welcomeEmailResourceIds[0] ?? null,
			purchaseBenefitApplicationResults: input.applicationResults,
		},
	})
	if (!claimedFields)
		return { status: 'skipped', reason: 'send-already-claimed' }

	try {
		await sendAnEmail({
			Component: BasicEmail,
			componentProps: {
				body:
					bespokeFields.body ??
					`Hi${user.name ? ` ${user.name.split(' ')[0]}` : ''},\n\nYour purchase includes extra access${benefitTitles.length ? ` to ${benefitTitles.join(', ')}` : ''}. It's ready in your account.\n\n${env.NEXT_PUBLIC_URL}/workshops\n\nQuestions? Reply here and we'll help.`,
				preview: bespokeFields.description ?? 'Your extra access is ready.',
				messageType: 'transactional',
			},
			Subject:
				bespokeFields.subject ?? `Your ${config.defaultTitle} access is ready`,
			To: user.email,
			ReplyTo: env.NEXT_PUBLIC_SUPPORT_EMAIL,
			From: env.NEXT_PUBLIC_SUPPORT_EMAIL,
			type: 'transactional',
		})
	} catch (error) {
		await markPurchaseFields(purchase.id, claimedFields, {
			purchaseBenefitWelcomeEmailReview: {
				state: 'needs_review',
				reason: 'welcome-email-send-failed',
				updatedAt: new Date().toISOString(),
			},
		})
		await alertPurchaseBenefitOperator({
			event: 'purchase_benefit.welcome_email.send_failed',
			title: 'Purchase Benefit welcome email failed',
			message: 'Buyer Purchase Benefit welcome email failed to send.',
			severity: 'error',
			envelope: {
				purchaseId: purchase.id,
				userId: purchase.userId,
				welcomeEmailResourceId: welcomeEmailResourceIds[0],
				reason: error instanceof Error ? error.message : String(error),
			},
		})
		throw error
	}

	const marker = new Date().toISOString()
	await markPurchaseFields(purchase.id, claimedFields, {
		purchaseBenefitWelcomeEmailSentAt: marker,
	})

	await log.info('purchase_benefit.welcome_email.sent', {
		purchaseId: purchase.id,
		userId: purchase.userId,
		welcomeEmailResourceId: welcomeEmailResourceIds[0],
		source: 'buyer_purchase' satisfies WelcomeEmailSource,
	})

	return {
		status: 'sent',
		marker,
		welcomeEmailResourceId: welcomeEmailResourceIds[0],
	}
}

export async function sendTeamSeatRedemptionWelcomeEmail(input: {
	redeemedPurchaseId: string
	bulkCouponId: string
	benefits: ExpandedPurchaseBenefit[]
	applicationResults: PurchaseBenefitEntitlementResult[]
}): Promise<WelcomeEmailResult> {
	const { redeemedPurchase, bulkCoupon } = await getTeamSeatPurchaseBenefits({
		redeemedPurchaseId: input.redeemedPurchaseId,
		bulkCouponId: input.bulkCouponId,
	})
	if (!redeemedPurchase) throw new Error('redeemed purchase not found')
	if (!redeemedPurchase.userId)
		throw new Error('redeemed purchase missing user')
	if (!bulkCoupon) throw new Error('bulk coupon not found')

	const fields = (redeemedPurchase.fields ?? {}) as Record<string, any>
	if (fields.teamSeatRedemptionWelcomeEmailSentAt) {
		return { status: 'skipped', reason: 'already-sent' }
	}
	if (fields.teamSeatRedemptionWelcomeEmailSendingAt) {
		return { status: 'skipped', reason: 'send-already-claimed' }
	}

	const welcomeEmailResourceIds = uniqueWelcomeEmailResourceIds(input.benefits)
	if (welcomeEmailResourceIds.length > 1) {
		await markPurchaseFields(redeemedPurchase.id, fields, {
			teamSeatRedemptionWelcomeEmailReview: {
				state: 'needs_review',
				reason: 'conflicting-welcome-email-resources',
				welcomeEmailResourceIds,
				updatedAt: new Date().toISOString(),
			},
			purchaseBenefitApplicationResults: input.applicationResults,
		})
		await alertPurchaseBenefitOperator({
			event: 'purchase_benefit.welcome_email.conflicting_resources',
			title: 'Purchase Benefit welcome email conflict',
			message:
				'Multiple distinct welcome email resources were configured for one team seat redemption followup.',
			envelope: {
				redeemedPurchaseId: redeemedPurchase.id,
				bulkCouponId: bulkCoupon.id,
				userId: redeemedPurchase.userId,
				welcomeEmailResourceId: welcomeEmailResourceIds.join(','),
				reason: 'conflicting-welcome-email-resources',
			},
		})
		return {
			status: 'review',
			reason: 'conflicting-welcome-email-resources',
			welcomeEmailResourceIds,
		}
	}

	const user = await db.query.users!.findFirst({
		where: eq(users.id, redeemedPurchase.userId as string),
	})
	if (!user?.email) throw new Error('user missing email')

	const product = await db.query.products!.findFirst({
		where: eq(products.id, redeemedPurchase.productId as string),
	})
	if (!product) throw new Error('product not found')

	const productResource = await db.query.contentResourceProduct!.findFirst({
		where: and(
			eq(contentResourceProduct.productId, product.id),
			isNull(contentResourceProduct.deletedAt),
		),
	})
	const primaryResource = productResource
		? await db.query.contentResource!.findFirst({
				where: and(
					eq(contentResource.id, productResource.resourceId),
					isNull(contentResource.deletedAt),
				),
				with: {
					resources: {
						with: { resource: true },
						orderBy: [asc(contentResourceResource.position)],
					},
				},
			})
		: null
	const parsedResource = ContentResourceSchema.parse(primaryResource ?? product)
	const availability =
		parsedResource.type === 'cohort' && (primaryResource as any)?.resources
			? getWorkshopAvailability((primaryResource as any).resources)
			: { availableNow: [], upcoming: [] }
	const contentUrl =
		env.NEXT_PUBLIC_URL +
		getResourcePath(parsedResource.type, parsedResource.fields?.slug, 'view')

	const benefitTitles = await getBenefitTitles(input.benefits)
	const bespokeEmail = welcomeEmailResourceIds[0]
		? await loadBespokeWelcomeEmail(welcomeEmailResourceIds[0])
		: null
	if (welcomeEmailResourceIds[0] && !bespokeEmail) {
		await alertPurchaseBenefitOperator({
			event: 'purchase_benefit.welcome_email.resource_not_found',
			title: 'Purchase Benefit welcome email is missing',
			message: `Could not find welcome email resource ${welcomeEmailResourceIds[0]}.`,
			envelope: {
				redeemedPurchaseId: redeemedPurchase.id,
				bulkCouponId: bulkCoupon.id,
				userId: redeemedPurchase.userId,
				welcomeEmailResourceId: welcomeEmailResourceIds[0],
				reason: 'welcome-email-resource-not-found',
			},
		})
	}
	const bespokeFields = (bespokeEmail?.fields ?? {}) as Record<string, any>
	const sendingAt = new Date().toISOString()
	const claimedFields = await claimWelcomeEmailSend({
		purchaseId: redeemedPurchase.id,
		fields,
		sentField: 'teamSeatRedemptionWelcomeEmailSentAt',
		sendingField: 'teamSeatRedemptionWelcomeEmailSendingAt',
		patch: {
			teamSeatRedemptionWelcomeEmailSendingAt: sendingAt,
			teamSeatRedemptionWelcomeEmailResourceId:
				welcomeEmailResourceIds[0] ?? null,
			purchaseBenefitApplicationResults: input.applicationResults,
		},
	})
	if (!claimedFields)
		return { status: 'skipped', reason: 'send-already-claimed' }

	try {
		if (bespokeEmail) {
			await sendAnEmail({
				Component: BasicEmail,
				componentProps: {
					body: bespokeFields.body ?? '',
					preview:
						bespokeFields.description ??
						`Welcome to ${parsedResource.fields?.title ?? config.defaultTitle}`,
					messageType: 'transactional',
				},
				Subject:
					bespokeFields.subject ??
					`Welcome to ${parsedResource.fields?.title ?? config.defaultTitle}!`,
				To: user.email,
				ReplyTo: env.NEXT_PUBLIC_SUPPORT_EMAIL,
				From: env.NEXT_PUBLIC_SUPPORT_EMAIL,
				type: 'transactional',
			})
		} else {
			await sendAnEmail({
				Component: WelcomeCohortEmailForTeamRedeemer,
				componentProps: {
					cohortTitle:
						parsedResource.fields?.title || parsedResource.fields?.slug,
					url: contentUrl,
					availableNow: availability.availableNow,
					upcoming: availability.upcoming,
					benefitTitles,
					userFirstName: user.name?.split(' ')[0],
				},
				Subject: `Welcome to ${parsedResource.fields?.title || config.defaultTitle}!`,
				To: user.email,
				ReplyTo: env.NEXT_PUBLIC_SUPPORT_EMAIL,
				From: env.NEXT_PUBLIC_SUPPORT_EMAIL,
				type: 'transactional',
			})
		}
	} catch (error) {
		await markPurchaseFields(redeemedPurchase.id, claimedFields, {
			teamSeatRedemptionWelcomeEmailReview: {
				state: 'needs_review',
				reason: 'welcome-email-send-failed',
				updatedAt: new Date().toISOString(),
			},
		})
		await alertPurchaseBenefitOperator({
			event: 'purchase_benefit.welcome_email.send_failed',
			title: 'Purchase Benefit welcome email failed',
			message: 'Team Seat Redemption welcome email failed to send.',
			severity: 'error',
			envelope: {
				redeemedPurchaseId: redeemedPurchase.id,
				bulkCouponId: bulkCoupon.id,
				userId: redeemedPurchase.userId,
				welcomeEmailResourceId: welcomeEmailResourceIds[0],
				reason: error instanceof Error ? error.message : String(error),
			},
		})
		throw error
	}

	const marker = new Date().toISOString()
	await markPurchaseFields(redeemedPurchase.id, claimedFields, {
		teamSeatRedemptionWelcomeEmailSentAt: marker,
	})

	await log.info('purchase_benefit.welcome_email.sent', {
		redeemedPurchaseId: redeemedPurchase.id,
		bulkCouponId: bulkCoupon.id,
		userId: redeemedPurchase.userId,
		welcomeEmailResourceId: welcomeEmailResourceIds[0],
		source: 'team_seat_redemption' satisfies WelcomeEmailSource,
	})

	return {
		status: 'sent',
		marker,
		welcomeEmailResourceId: welcomeEmailResourceIds[0],
	}
}
