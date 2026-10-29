import { createHmac } from 'node:crypto'
import { z } from 'zod'

/**
 * Agent coupon minting for /api/support/coupons and `aihero coupon mint`.
 *
 * A 100% coupon is stored exactly like the hand-minted free C5 batches:
 * restricted to one product, no merchant coupon, `fields.bypassSoldOut`, and it
 * redeems through Course Builder's `redeemFullPriceCoupon` at `?code=<id>`.
 * Below 100% the admin form's merchant coupon (and its Stripe coupon) is reused.
 *
 * Idempotency needs no extra table: coupon ids are an HMAC of the actor, the
 * Idempotency-Key and the row index. A retry derives the same ids, and the
 * primary key refuses a second insert even when two requests race.
 */

export const COUPON_MINT_MAX_QUANTITY = 50
export const COUPON_MINT_MAX_USES = 100

const label = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'label must be a short lowercase slug')

export const CouponMintRequestSchema = z
	.object({
		productId: z.string().min(1).max(191),
		percentageDiscount: z
			.number()
			.gt(0)
			.lte(1)
			// The Coupon column is DECIMAL(3,2); refuse values it would round.
			.refine(
				(value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
				{
					message: 'percentageDiscount allows at most two decimal places',
				},
			),
		maxUses: z.number().int().min(1).max(COUPON_MINT_MAX_USES).default(1),
		quantity: z.number().int().min(1).max(COUPON_MINT_MAX_QUANTITY).default(1),
		expiresAt: z.string().datetime({ offset: true }).optional(),
		label: label.optional(),
		bypassSoldOut: z.boolean().optional(),
	})
	.strict()

export type CouponMintRequest = z.input<typeof CouponMintRequestSchema>

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{16,200}$/

export const CouponListQuerySchema = z
	.object({
		productId: z.string().min(1).max(191),
		label: label.optional(),
	})
	.strict()

export type StoredCoupon = {
	id: string
	restrictedToProductId: string | null
	percentageDiscount: string | null
	maxUses: number
	usedCount: number
	expires: Date | null
	merchantCouponId: string | null
	status: number
	fields: Record<string, unknown> | null
	createdAt?: Date | null
}

export type NewCouponRow = {
	id: string
	restrictedToProductId: string
	percentageDiscount: string
	maxUses: number
	expires: Date | null
	merchantCouponId: string | null
	status: 1
	default: false
	fields: Record<string, unknown>
}

export type CouponMintStore = {
	findProduct(id: string): Promise<{ id: string; name: string } | null>
	findCoupons(ids: string[]): Promise<StoredCoupon[]>
	/** All rows or none: one transaction. */
	insertCoupons(rows: NewCouponRow[]): Promise<void>
	listCoupons(query: {
		productId: string
		label?: string
		limit: number
	}): Promise<StoredCoupon[]>
}

export type CouponMintActor = { userId: string; authMethod: string }

export type CouponMintDeps = {
	store: CouponMintStore
	createOrFindMerchantCoupon(percentageDiscount: number): Promise<string | null>
	isDuplicateEntryError(error: unknown): boolean
	idSecret: string
	inviteUrl(couponId: string): string
	now?: () => Date
}

export type CouponMintResult =
	| {
			state: 'minted' | 'replayed'
			productId: string
			productName: string
			percentageDiscount: number
			maxUses: number
			label: string | null
			merchantCouponId: string | null
			coupons: { id: string; url: string }[]
	  }
	| { state: 'invalid'; error: string }
	| { state: 'not_found'; error: string }
	| { state: 'conflict'; error: string }

type NormalizedMint = {
	productId: string
	percentageDiscount: number
	maxUses: number
	quantity: number
	expires: Date | null
	label: string | null
	bypassSoldOut: boolean
}

export function deriveCouponIds({
	secret,
	actorId,
	idempotencyKey,
	quantity,
}: {
	secret: string
	actorId: string
	idempotencyKey: string
	quantity: number
}) {
	return Array.from(
		{ length: quantity },
		(_, index) =>
			`coupon_${createHmac('sha256', secret)
				.update(`coupon-mint:v1:${actorId}:${idempotencyKey}:${index}`)
				.digest('hex')
				.slice(0, 24)}`,
	)
}

function normalize(
	request: z.output<typeof CouponMintRequestSchema>,
): NormalizedMint {
	const percentageDiscount = Math.round(request.percentageDiscount * 100) / 100
	return {
		productId: request.productId,
		percentageDiscount,
		maxUses: request.maxUses,
		quantity: request.quantity,
		expires: request.expiresAt ? new Date(request.expiresAt) : null,
		label: request.label ?? null,
		bypassSoldOut: request.bypassSoldOut ?? percentageDiscount === 1,
	}
}

/** Does a stored row carry exactly what this request would have written? */
function rowMatches(row: StoredCoupon, mint: NormalizedMint) {
	const fields = row.fields ?? {}
	return (
		row.restrictedToProductId === mint.productId &&
		Number(row.percentageDiscount) === mint.percentageDiscount &&
		row.maxUses === mint.maxUses &&
		(row.expires?.getTime() ?? null) === (mint.expires?.getTime() ?? null) &&
		(fields.mintedFor ?? null) === mint.label &&
		(fields.bypassSoldOut === true) === mint.bypassSoldOut
	)
}

export async function mintCoupons(
	{
		actor,
		idempotencyKey,
		request,
	}: { actor: CouponMintActor; idempotencyKey: string; request: unknown },
	deps: CouponMintDeps,
): Promise<CouponMintResult> {
	if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))
		return {
			state: 'invalid',
			error: 'Idempotency-Key must be 16-200 characters of A-Z a-z 0-9 _ . : -',
		}
	const parsed = CouponMintRequestSchema.safeParse(request)
	if (!parsed.success)
		return {
			state: 'invalid',
			error: parsed.error.issues
				.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
				.join('; '),
		}
	const mint = normalize(parsed.data)
	const now = deps.now?.() ?? new Date()
	if (mint.expires && mint.expires.getTime() <= now.getTime())
		return { state: 'invalid', error: 'expiresAt must be in the future' }

	const product = await deps.store.findProduct(mint.productId)
	if (!product)
		return { state: 'not_found', error: `Unknown product ${mint.productId}` }

	const ids = deriveCouponIds({
		secret: deps.idSecret,
		actorId: actor.userId,
		idempotencyKey,
		quantity: mint.quantity,
	})

	const settle = (
		state: 'minted' | 'replayed',
		merchantCouponId: string | null,
	): CouponMintResult => ({
		state,
		productId: product.id,
		productName: product.name,
		percentageDiscount: mint.percentageDiscount,
		maxUses: mint.maxUses,
		label: mint.label,
		merchantCouponId,
		coupons: ids.map((id) => ({ id, url: deps.inviteUrl(id) })),
	})

	const replay = async (): Promise<CouponMintResult | null> => {
		const existing = await deps.store.findCoupons(ids)
		if (existing.length === 0) return null
		if (
			existing.length !== ids.length ||
			!existing.every((row) => rowMatches(row, mint))
		)
			return {
				state: 'conflict',
				error:
					'This Idempotency-Key already minted a different batch. Use a new key.',
			}
		return settle('replayed', existing[0]!.merchantCouponId)
	}

	const before = await replay()
	if (before) return before

	// 100% coupons redeem without Stripe; only partial discounts need one.
	const merchantCouponId =
		mint.percentageDiscount < 1
			? await deps.createOrFindMerchantCoupon(mint.percentageDiscount)
			: null

	const fields: Record<string, unknown> = {
		...(mint.bypassSoldOut ? { bypassSoldOut: true } : {}),
		...(mint.label ? { mintedFor: mint.label } : {}),
	}
	try {
		await deps.store.insertCoupons(
			ids.map((id) => ({
				id,
				restrictedToProductId: product.id,
				percentageDiscount: mint.percentageDiscount.toFixed(2),
				maxUses: mint.maxUses,
				expires: mint.expires,
				merchantCouponId,
				status: 1,
				default: false,
				fields,
			})),
		)
	} catch (error) {
		// A concurrent request with the same key won the insert.
		if (!deps.isDuplicateEntryError(error)) throw error
		const raced = await replay()
		if (raced) return raced
		throw error
	}
	return settle('minted', merchantCouponId)
}

export type CouponListResult = {
	productId: string
	label: string | null
	truncated: boolean
	totals: {
		coupons: number
		unused: number
		partlyUsed: number
		usedUp: number
		expired: number
		redemptions: number
		seats: number
	}
	coupons: {
		id: string
		url: string
		usedCount: number
		maxUses: number
		percentageDiscount: number
		expires: string | null
		label: string | null
	}[]
}

export const COUPON_LIST_LIMIT = 500

export async function listMintedCoupons(
	query: z.output<typeof CouponListQuerySchema>,
	deps: Pick<CouponMintDeps, 'store' | 'inviteUrl' | 'now'>,
): Promise<CouponListResult> {
	const now = deps.now?.() ?? new Date()
	const rows = await deps.store.listCoupons({
		productId: query.productId,
		label: query.label,
		limit: COUPON_LIST_LIMIT + 1,
	})
	const truncated = rows.length > COUPON_LIST_LIMIT
	const shown = rows.slice(0, COUPON_LIST_LIMIT)
	const totals = {
		coupons: shown.length,
		unused: 0,
		partlyUsed: 0,
		usedUp: 0,
		expired: 0,
		redemptions: 0,
		seats: 0,
	}
	for (const row of shown) {
		totals.redemptions += row.usedCount
		totals.seats += Math.max(row.maxUses, 0)
		if (row.maxUses > 0 && row.usedCount >= row.maxUses) totals.usedUp++
		else if (row.usedCount > 0) totals.partlyUsed++
		else totals.unused++
		if (row.expires && row.expires.getTime() <= now.getTime()) totals.expired++
	}
	return {
		productId: query.productId,
		label: query.label ?? null,
		truncated,
		totals,
		coupons: shown.map((row) => ({
			id: row.id,
			url: deps.inviteUrl(row.id),
			usedCount: row.usedCount,
			maxUses: row.maxUses,
			percentageDiscount: Number(row.percentageDiscount),
			expires: row.expires ? row.expires.toISOString() : null,
			label:
				typeof row.fields?.mintedFor === 'string' ? row.fields.mintedFor : null,
		})),
	}
}
