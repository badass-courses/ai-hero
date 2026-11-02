import { TeamManagerError } from '@/lib/team-manager-invitations'
import { isTeamPurchaseManagerRole } from '@/lib/team-roles'
import { z } from 'zod'

import type { Purchase } from '@coursebuilder/core/schemas'

/** Most addresses one submission may add. Larger teams submit in batches. */
export const MAX_SEAT_EMAILS_PER_SUBMISSION = 50

const REDEEMABLE_PURCHASE_STATES = new Set(['Valid', 'Restricted'])

export type SeatEmailResult = {
	email: string
	status:
		| 'added'
		| 'added-email-failed'
		| 'already-had-access'
		| 'no-seats-left'
		| 'invalid'
		| 'failed'
}

export type TeamSeatPurchase = Pick<
	Purchase,
	'id' | 'organizationId' | 'productId' | 'bulkCouponId' | 'status'
>

export type TeamSeatCoupon = {
	id: string
	maxUses: number
	usedCount: number
	status: number
}

export type TeamSeatRedemption = {
	purchase: Pick<
		Purchase,
		'id' | 'userId' | 'productId' | 'redeemedBulkCouponId'
	> | null
	redeemingForCurrentUser: boolean
	error?: { message: string }
} | null

export type TeamSeatRedemptionDataSource = {
	loadPurchase(purchaseId: string): Promise<TeamSeatPurchase | undefined>
	/** Active role names the user holds in the organization. */
	loadActorRoles(userId: string, organizationId: string): Promise<string[]>
	loadCoupon(couponId: string): Promise<TeamSeatCoupon | null>
	findUserIdByEmail(email: string): Promise<string | null>
	/** Any valid or restricted purchase of the product, bulk seat or not. */
	userOwnsProduct(userId: string, productId: string): Promise<boolean>
	/** The app's guarded `courseBuilderAdapter.redeemFullPriceCoupon`. */
	redeemFullPriceCoupon(options: {
		email: string
		couponId: string
		productIds: string[]
		currentUserId?: string | null
		redeemingProductId: string
	}): Promise<TeamSeatRedemption>
	/** The events and login email Course Builder's `redeem` action sends. */
	afterSeatRedeemed(input: {
		email: string
		redemption: NonNullable<TeamSeatRedemption>
	}): Promise<void>
}

const emailSchema = z.string().trim().toLowerCase().email().max(255)

/**
 * Split pasted text on commas, semicolons and whitespace. Lowercases, drops
 * duplicates and keeps the first-seen order.
 */
export function parseSeatEmails(raw: string): {
	emails: string[]
	invalid: string[]
} {
	const emails: string[] = []
	const invalid: string[] = []
	const seen = new Set<string>()
	for (const token of raw.split(/[\s,;]+/)) {
		if (!token) continue
		const parsed = emailSchema.safeParse(token.replace(/^<|>$/g, ''))
		if (!parsed.success) {
			if (!invalid.includes(token)) invalid.push(token)
			continue
		}
		if (seen.has(parsed.data)) continue
		seen.add(parsed.data)
		emails.push(parsed.data)
	}
	return { emails, invalid }
}

function isAlreadyClaimedError(message: string | undefined): boolean {
	return Boolean(
		message &&
		(message === 'team-seat-redemption-already-claimed' ||
			message.startsWith('already-purchased')),
	)
}

async function requirePurchaseManager(
	actorUserId: string,
	purchaseId: string,
	dataSource: TeamSeatRedemptionDataSource,
): Promise<
	TeamSeatPurchase & { bulkCouponId: string; organizationId: string }
> {
	const forbidden = new TeamManagerError(
		'forbidden',
		'You do not have permission to manage this team.',
	)
	const purchase = await dataSource.loadPurchase(purchaseId)
	if (!purchase?.organizationId || !purchase.bulkCouponId) throw forbidden
	const roles = await dataSource.loadActorRoles(
		actorUserId,
		purchase.organizationId,
	)
	if (!roles.some((role) => isTeamPurchaseManagerRole(role))) throw forbidden
	if (!REDEEMABLE_PURCHASE_STATES.has(purchase.status)) {
		throw new TeamManagerError(
			'forbidden',
			'This purchase no longer has seats to give out.',
		)
	}
	return {
		...purchase,
		organizationId: purchase.organizationId,
		bulkCouponId: purchase.bulkCouponId,
	}
}

/**
 * Give free seats of a team purchase to the listed addresses, in order, until
 * the seats run out. Seats are non-transferable, so nobody who already owns
 * the product takes another one.
 */
export async function addTeamSeatsByEmail(
	input: { actorUserId: string; purchaseId: string; emails: string },
	dataSource: TeamSeatRedemptionDataSource,
): Promise<{ results: SeatEmailResult[]; addedCount: number }> {
	const purchase = await requirePurchaseManager(
		input.actorUserId,
		input.purchaseId,
		dataSource,
	)
	const { emails, invalid } = parseSeatEmails(input.emails)
	if (emails.length === 0 && invalid.length === 0) {
		throw new TeamManagerError(
			'invalid-email',
			'Enter at least one email address.',
		)
	}
	if (emails.length > MAX_SEAT_EMAILS_PER_SUBMISSION) {
		throw new TeamManagerError(
			'invalid-email',
			`Add up to ${MAX_SEAT_EMAILS_PER_SUBMISSION} addresses at a time.`,
		)
	}

	const coupon = await dataSource.loadCoupon(purchase.bulkCouponId)
	let seatsLeft =
		coupon && coupon.status === 1
			? Math.max(0, coupon.maxUses - coupon.usedCount)
			: 0

	const results: SeatEmailResult[] = []
	for (const email of emails) {
		if (seatsLeft <= 0) {
			results.push({ email, status: 'no-seats-left' })
			continue
		}

		const existingUserId = await dataSource.findUserIdByEmail(email)
		if (
			existingUserId &&
			(await dataSource.userOwnsProduct(existingUserId, purchase.productId))
		) {
			results.push({ email, status: 'already-had-access' })
			continue
		}

		let redemption: TeamSeatRedemption
		try {
			redemption = await dataSource.redeemFullPriceCoupon({
				email,
				couponId: purchase.bulkCouponId,
				productIds: [purchase.productId],
				currentUserId: existingUserId,
				redeemingProductId: purchase.productId,
			})
		} catch {
			results.push({ email, status: 'failed' })
			continue
		}

		if (!redemption) {
			// The coupon stopped validating: its seats ran out under us.
			seatsLeft = 0
			results.push({ email, status: 'no-seats-left' })
			continue
		}
		if (!redemption.purchase) {
			results.push({
				email,
				status: isAlreadyClaimedError(redemption.error?.message)
					? 'already-had-access'
					: 'failed',
			})
			continue
		}

		seatsLeft -= 1
		try {
			await dataSource.afterSeatRedeemed({ email, redemption })
			results.push({ email, status: 'added' })
		} catch {
			// The seat is taken; only the follow-up email or event failed.
			results.push({ email, status: 'added-email-failed' })
		}
	}

	for (const token of invalid) results.push({ email: token, status: 'invalid' })

	return {
		results,
		addedCount: results.filter(
			({ status }) => status === 'added' || status === 'added-email-failed',
		).length,
	}
}
