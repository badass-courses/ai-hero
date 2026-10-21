import { emailProvider } from '@/coursebuilder/email-provider'
import { courseBuilderAdapter, db } from '@/db'
import { organizationMemberships, purchases } from '@/db/schema'
import { env } from '@/env.mjs'
import { inngest } from '@/inngest/inngest.server'
import type { TeamSeatRedemptionDataSource } from '@/lib/team-seat-redemption'
import { authOptions } from '@/server/auth'
import { log } from '@/server/logger'
import { and, eq, inArray } from 'drizzle-orm'
import type { NextAuthConfig } from 'next-auth'

import {
	FULL_PRICE_COUPON_REDEEMED_EVENT,
	TEAM_SEAT_REDEMPTION_CREATED_EVENT,
} from '@coursebuilder/core/events/commerce'
import { sendServerEmail } from '@coursebuilder/email/send-server-email'

const OWNED_PURCHASE_STATES = ['Valid', 'Restricted']

/** Adapter errors can embed the learner's address; logs never carry it. */
function redactedMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error)
	return message.replace(/[^\s@:]+@[^\s@:]+/g, '[email]')
}

/**
 * Production wiring. Redemption goes through the app's guarded adapter, and
 * the follow-up mirrors Course Builder's `redeem` action step for step.
 */
export const drizzleTeamSeatRedemptionDataSource: TeamSeatRedemptionDataSource =
	{
		async loadPurchase(purchaseId) {
			const purchase = await db.query.purchases.findFirst({
				where: eq(purchases.id, purchaseId),
			})
			return purchase ?? undefined
		},

		async loadActorRoles(userId, organizationId) {
			const membership = await db.query.organizationMemberships.findFirst({
				where: and(
					eq(organizationMemberships.userId, userId),
					eq(organizationMemberships.organizationId, organizationId),
				),
				with: { organizationMembershipRoles: { with: { role: true } } },
			})
			return (membership?.organizationMembershipRoles ?? []).flatMap(
				(membershipRole) =>
					membershipRole.active &&
					!membershipRole.deletedAt &&
					membershipRole.role.active &&
					!membershipRole.role.deletedAt
						? [membershipRole.role.name]
						: [],
			)
		},

		async loadCoupon(couponId) {
			return courseBuilderAdapter.getCouponWithBulkPurchases(couponId)
		},

		async findUserIdByEmail(email) {
			const user = await courseBuilderAdapter.getUserByEmail?.(email)
			return user?.id ?? null
		},

		async userOwnsProduct(userId, productId) {
			const owned = await db.query.purchases.findFirst({
				where: and(
					eq(purchases.userId, userId),
					eq(purchases.productId, productId),
					inArray(purchases.status, OWNED_PURCHASE_STATES),
				),
				columns: { id: true },
			})
			return Boolean(owned)
		},

		async redeemFullPriceCoupon(options) {
			try {
				return await courseBuilderAdapter.redeemFullPriceCoupon(options)
			} catch (error) {
				await log.error('team.seats.redeem-failed', {
					couponId: options.couponId,
					error: redactedMessage(error),
				})
				throw error
			}
		},

		async afterSeatRedeemed(input) {
			try {
				await sendSeatFollowUp(input)
			} catch (error) {
				await log.error('team.seats.follow-up-failed', {
					purchaseId: input.redemption.purchase?.id,
					error: redactedMessage(error),
				})
				throw error
			}
		},
	}

async function sendSeatFollowUp({
	email,
	redemption,
}: Parameters<TeamSeatRedemptionDataSource['afterSeatRedeemed']>[0]) {
	const { purchase, redeemingForCurrentUser } = redemption
	if (!purchase?.userId) return
	const user = await courseBuilderAdapter.getUserById(purchase.userId)
	const userEmail = user?.email || email

	if (purchase.redeemedBulkCouponId) {
		await inngest.send({
			name: TEAM_SEAT_REDEMPTION_CREATED_EVENT,
			data: {
				redeemedPurchaseId: purchase.id,
				bulkCouponId: purchase.redeemedBulkCouponId,
				userId: purchase.userId,
				userEmail,
				productId: purchase.productId,
			},
			user: { id: purchase.userId, email: userEmail },
		})
	}

	const product = await courseBuilderAdapter.getProduct(purchase.productId)
	if (product) {
		await inngest.send({
			name: FULL_PRICE_COUPON_REDEEMED_EVENT,
			data: {
				purchaseId: purchase.id,
				productType: product.type || 'self-paced',
				checkoutSessionId: `coupon-${purchase.id}`,
			},
			user: { id: purchase.userId, email: userEmail },
		})
	}

	// An existing account is "the current user" to Course Builder's redeem
	// and gets no login email; a new account gets one, as with the invite
	// link.
	if (!redeemingForCurrentUser) {
		if (!user) throw new Error('team-seat-user-not-found')
		await sendServerEmail({
			email: user.email,
			baseUrl: env.COURSEBUILDER_URL,
			callbackUrl: `${env.COURSEBUILDER_URL}/welcome?purchaseId=${purchase.id}`,
			adapter: courseBuilderAdapter,
			authOptions: authOptions as NextAuthConfig,
			emailProvider,
		})
	}
}
