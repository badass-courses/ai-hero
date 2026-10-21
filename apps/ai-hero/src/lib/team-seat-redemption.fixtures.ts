import { vi } from 'vitest'

import type { TeamSeatRedemptionDataSource } from './team-seat-redemption'

export const purchaseId = 'purchase-team'
export const couponId = 'coupon-bulk'
export const productId = 'product-crash-course'
const organizationId = 'org-a'

/**
 * In-memory stand-in for the guarded adapter: the coupon counts its uses and
 * stops validating when they run out, as `validateCoupon` does.
 */
export function createFakeSeatDataSource(options: {
	seats: number
	usedCount?: number
	roles?: Record<string, string[]>
	owners?: string[]
	purchaseStatus?: string
	failFollowUpFor?: string[]
	adapterError?: Record<string, string>
}) {
	const coupon = {
		id: couponId,
		maxUses: options.seats,
		usedCount: options.usedCount ?? 0,
		status: 1,
	}
	const users = new Map<string, string>()
	const owned = new Set<string>()
	for (const email of options.owners ?? []) {
		users.set(email, `user-${email}`)
		owned.add(`user-${email}`)
	}
	const roles = options.roles ?? { 'user-owner': ['owner'] }

	const dataSource: TeamSeatRedemptionDataSource = {
		loadPurchase: vi.fn(async (id: string) =>
			id === purchaseId
				? {
						id,
						organizationId,
						productId,
						bulkCouponId: couponId,
						status: options.purchaseStatus ?? 'Valid',
					}
				: undefined,
		),
		loadActorRoles: vi.fn(async (userId: string, orgId: string) =>
			orgId === organizationId ? (roles[userId] ?? []) : [],
		),
		loadCoupon: vi.fn(async () => ({ ...coupon })),
		findUserIdByEmail: vi.fn(async (email: string) => users.get(email) ?? null),
		userOwnsProduct: vi.fn(async (userId: string) => owned.has(userId)),
		redeemFullPriceCoupon: vi.fn(async ({ email, currentUserId }) => {
			const adapterError = options.adapterError?.[email]
			if (adapterError) {
				return {
					purchase: null,
					redeemingForCurrentUser: Boolean(currentUserId),
					error: { message: adapterError },
				}
			}
			if (coupon.usedCount >= coupon.maxUses) return null
			coupon.usedCount += 1
			const userId = users.get(email) ?? `user-${email}`
			users.set(email, userId)
			owned.add(userId)
			return {
				purchase: {
					id: `seat-${email}`,
					userId,
					productId,
					redeemedBulkCouponId: couponId,
				},
				redeemingForCurrentUser: currentUserId === userId,
			}
		}),
		afterSeatRedeemed: vi.fn(async ({ email }) => {
			if (options.failFollowUpFor?.includes(email)) {
				throw new Error('postmark down')
			}
		}),
	}
	return { dataSource, coupon }
}
