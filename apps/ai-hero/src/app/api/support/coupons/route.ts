import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/env.mjs'
import {
	CouponListQuerySchema,
	listMintedCoupons,
	mintCoupons,
	type CouponMintActor,
} from '@/lib/coupon-mint'
import { drizzleCouponMintStore } from '@/lib/coupon-mint-drizzle'
import { createOrFindMerchantCoupon } from '@/lib/merchant-coupons'
import { isMysqlDuplicateEntryError } from '@/lib/mysql-primary-key-retry'
import { getCouponInviteUrl } from '@/lib/team-invite-url'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

export const dynamic = 'force-dynamic'

const headers = {
	'Cache-Control': 'private, no-store',
	'Referrer-Policy': 'no-referrer',
}
const response = (body: unknown, status = 200) =>
	NextResponse.json(body, { status, headers })

const statusFor = {
	minted: 201,
	replayed: 200,
	invalid: 400,
	not_found: 404,
	conflict: 409,
} as const

const inviteUrl = (couponId: string) =>
	getCouponInviteUrl(couponId, env.NEXT_PUBLIC_URL || 'https://www.aihero.dev')

/**
 * Coupon minting for agents and `aihero coupon`. Unlike the HMAC routes beside
 * it, this takes the CLI's bearer device token, so every mint has a named actor.
 * Only an unscoped token whose owner can manage everything (an admin) passes:
 * PATs and scoped device tokens never carry `manage all`.
 */
async function authorize(
	request: NextRequest,
): Promise<{ actor: CouponMintActor } | { refused: NextResponse }> {
	const { user, ability, authMethod } = await getUserAbilityForRequest(request)
	if (!user) return { refused: response({ error: 'Unauthorized' }, 401) }
	if (!ability.can('manage', 'all'))
		return {
			refused: response({ error: 'Forbidden: admin token required' }, 403),
		}
	return { actor: { userId: user.id, authMethod } }
}

/** POST /api/support/coupons: mint a batch. Requires an Idempotency-Key. */
export const POST = withSkill(async (request: NextRequest) => {
	const auth = await authorize(request)
	if ('refused' in auth) return auth.refused
	// The coupon id derivation key; without it a retry could mint twice.
	if (!env.NEXTAUTH_SECRET)
		return response({ error: 'Coupon minting not configured' }, 503)
	const idempotencyKey = request.headers.get('idempotency-key')
	if (!idempotencyKey)
		return response({ error: 'Idempotency-Key header is required' }, 400)
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return response({ error: 'Invalid JSON body' }, 400)
	}

	const result = await mintCoupons(
		{ actor: auth.actor, idempotencyKey, request: body },
		{
			store: drizzleCouponMintStore,
			createOrFindMerchantCoupon: (percentageDiscount) =>
				createOrFindMerchantCoupon(percentageDiscount),
			isDuplicateEntryError: isMysqlDuplicateEntryError,
			idSecret: env.NEXTAUTH_SECRET,
			inviteUrl,
		},
	)
	if ('coupons' in result) {
		await log
			.info(
				result.state === 'minted' ? 'coupon.minted' : 'coupon.mint_replayed',
				{
					actorUserId: auth.actor.userId,
					authMethod: auth.actor.authMethod,
					productId: result.productId,
					percentageDiscount: result.percentageDiscount,
					maxUses: result.maxUses,
					quantity: result.coupons.length,
					label: result.label,
					merchantCouponId: result.merchantCouponId,
					couponIds: result.coupons.map((coupon) => coupon.id),
				},
			)
			.catch(() => undefined)
		return response(result, statusFor[result.state])
	}
	await log
		.warn('coupon.mint_refused', {
			actorUserId: auth.actor.userId,
			state: result.state,
			error: result.error,
		})
		.catch(() => undefined)
	return response(
		{ state: result.state, error: result.error },
		statusFor[result.state],
	)
})

/** GET /api/support/coupons?productId=&label=: read-only batch counts. */
export const GET = withSkill(async (request: NextRequest) => {
	const auth = await authorize(request)
	if ('refused' in auth) return auth.refused
	const { searchParams } = new URL(request.url)
	const parsed = CouponListQuerySchema.safeParse({
		productId: searchParams.get('productId') ?? undefined,
		label: searchParams.get('label') ?? undefined,
	})
	if (!parsed.success)
		return response({ error: 'productId is required; label is a slug' }, 400)
	return response(
		await listMintedCoupons(parsed.data, {
			store: drizzleCouponMintStore,
			inviteUrl,
		}),
	)
})
