import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'

/**
 * Agent coupon minting for /api/support/coupons and `aihero coupon mint`.
 *
 * A 100% coupon is stored exactly like the hand-minted free C5 batches:
 * restricted to one product, no merchant coupon, `fields.bypassSoldOut`, and it
 * redeems through Course Builder's `redeemFullPriceCoupon` at `?code=<id>`.
 * Below 100% the admin form's merchant coupon (and its Stripe coupon) is reused.
 *
 * Idempotency needs no extra table. Every row stores `fields.mintKey` (a hash
 * of the actor and the Idempotency-Key) and `fields.mintRequest` (a hash of the
 * whole normalized request, quantity included). A retry finds the batch by
 * mintKey and replays it only when the request hash matches; anything else is a
 * 409. That lookup does not depend on any secret, so rotating NEXTAUTH_SECRET
 * cannot turn a retry into a second batch.
 *
 * Coupon ids are still an HMAC of the actor, the key and the row index: an id is
 * a redeem code, so it must not be guessable from the key, and the primary key
 * refuses a second insert when two requests with the same key race.
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
	/** Every coupon whose `fields.mintKey` equals this hash. */
	findCouponsByMintKey(mintKey: string): Promise<StoredCoupon[]>
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

/** Secret-free batch identity: the same actor and key always find the batch. */
export function deriveMintKey(actorId: string, idempotencyKey: string) {
	return createHash('sha256')
		.update(`coupon-mint:key:v1:${actorId}:${idempotencyKey}`)
		.digest('hex')
}

/** Hash of everything the request asked for; any difference is a conflict. */
function hashMintRequest(mint: NormalizedMint) {
	return createHash('sha256')
		.update(
			JSON.stringify([
				'coupon-mint:request:v1',
				mint.productId,
				mint.percentageDiscount.toFixed(2),
				mint.maxUses,
				mint.quantity,
				mint.expires?.toISOString() ?? null,
				mint.label,
				mint.bypassSoldOut,
			]),
		)
		.digest('hex')
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

	const mintKey = deriveMintKey(actor.userId, idempotencyKey)
	const mintRequest = hashMintRequest(mint)

	const settle = (
		state: 'minted' | 'replayed',
		merchantCouponId: string | null,
		couponIds: string[],
	): CouponMintResult => ({
		state,
		productId: product.id,
		productName: product.name,
		percentageDiscount: mint.percentageDiscount,
		maxUses: mint.maxUses,
		label: mint.label,
		merchantCouponId,
		coupons: couponIds.map((id) => ({ id, url: deps.inviteUrl(id) })),
	})

	const replay = async (): Promise<CouponMintResult | null> => {
		const existing = await deps.store.findCouponsByMintKey(mintKey)
		if (existing.length === 0) return null
		// The whole request is bound to the key: a smaller quantity, or any other
		// change, must not replay a prefix of a live batch.
		if (
			existing.length !== mint.quantity ||
			!existing.every(
				(row) =>
					row.fields?.mintRequest === mintRequest && rowMatches(row, mint),
			)
		)
			return {
				state: 'conflict',
				error:
					'This Idempotency-Key already minted a different batch. Use a new key.',
			}
		// Return the stored ids, not freshly derived ones, so replay survives a
		// secret rotation.
		const ordered = [...existing].sort(
			(a, b) => Number(a.fields?.mintIndex) - Number(b.fields?.mintIndex),
		)
		return settle(
			'replayed',
			ordered[0]!.merchantCouponId,
			ordered.map((row) => row.id),
		)
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
		mintKey,
		mintRequest,
	}
	try {
		await deps.store.insertCoupons(
			ids.map((id, mintIndex) => ({
				id,
				restrictedToProductId: product.id,
				percentageDiscount: mint.percentageDiscount.toFixed(2),
				maxUses: mint.maxUses,
				expires: mint.expires,
				merchantCouponId,
				status: 1,
				default: false,
				fields: { ...fields, mintIndex },
			})),
		)
	} catch (error) {
		// A concurrent request with the same key won the insert.
		if (!deps.isDuplicateEntryError(error)) throw error
		const raced = await replay()
		if (raced) return raced
		throw error
	}
	return settle('minted', merchantCouponId, ids)
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
