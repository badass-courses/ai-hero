import { z } from 'zod'

const cents = z.number().int().nonnegative().safe()
const currency = z.string().regex(/^[a-z]{3}$/)
const identifier = z.string().min(1)
const instant = z.string().datetime({ offset: true })

export const PurchaseFactsSchema = z.object({
	purchaseId: identifier.optional(),
	couponId: identifier.optional(),
	priceClass: z.enum(['team', 'coupon', 'ppp', 'full']).optional(),
	amountCents: cents.optional(),
	currency: currency.optional(),
	couponIssueContactId: identifier.optional(),
	couponIssuedAt: instant.optional(),
	couponExpiresAt: instant.optional(),
})

export type PurchaseFacts = z.infer<typeof PurchaseFactsSchema>

const PurchaseFactsEnvelopeSchema = z.object({ purchaseFacts: PurchaseFactsSchema })

export function readPurchaseFacts(domainPayload: unknown): PurchaseFacts | undefined {
	const parsed = PurchaseFactsEnvelopeSchema.safeParse(domainPayload)
	return parsed.success ? parsed.data.purchaseFacts : undefined
}

export const PurchaseRefundFactsSchema = z.object({
	purchaseId: identifier,
	refundId: identifier,
	amountCents: cents,
	currency,
})

export type PurchaseRefundFacts = z.infer<typeof PurchaseRefundFactsSchema>

const CapturedChargeSchema = z.object({
	paid: z.literal(true),
	captured: z.literal(true),
	status: z.literal('succeeded'),
	amount_captured: cents,
	currency,
})

export function capturedChargeFacts(
	charge: unknown,
): { amountCents: number; currency: string } | undefined {
	const parsed = CapturedChargeSchema.safeParse(charge)
	return parsed.success
		? {
				amountCents: parsed.data.amount_captured,
				currency: parsed.data.currency,
			}
		: undefined
}

export function purchaseFacts(args: {
	purchaseId: string
	productId: string
	status: string
	couponId?: string | null
	bulkCouponId?: string | null
	redeemedBulkCouponId?: string | null
	charge?: unknown
	evergreenOffer?: {
		contactId: string
		issuedAt?: string
		expiresAt?: string
	}
}): PurchaseFacts {
	const charge = args.redeemedBulkCouponId
		? undefined
		: capturedChargeFacts(args.charge)
	const paying = charge !== undefined && charge.amountCents > 0
	const priceClass = !paying
		? undefined
		: args.bulkCouponId
			? 'team'
			: args.couponId
				? 'coupon'
				: args.status === 'Restricted'
					? 'ppp'
					: args.productId === 'product-ma254' &&
						  charge.currency === 'usd' &&
						  charge.amountCents === 29900
						? 'full'
						: undefined
	return PurchaseFactsSchema.parse({
		purchaseId: args.purchaseId,
		...(args.couponId ? { couponId: args.couponId } : {}),
		...(priceClass ? { priceClass } : {}),
		...charge,
		...(args.evergreenOffer
			? {
					couponIssueContactId: args.evergreenOffer.contactId,
					...(args.evergreenOffer.issuedAt
						? { couponIssuedAt: args.evergreenOffer.issuedAt }
						: {}),
					...(args.evergreenOffer.expiresAt
						? { couponExpiresAt: args.evergreenOffer.expiresAt }
						: {}),
				}
			: {}),
	})
}

const SucceededRefundSchema = z.object({
	id: identifier,
	status: z.literal('succeeded'),
	amount: cents,
	currency,
	created: z.number().int().nonnegative().safe(),
})

export function purchaseRefundFacts(args: {
	purchaseId: string
	refund: unknown
}): { facts: PurchaseRefundFacts; occurredAt: string } | undefined {
	const parsed = SucceededRefundSchema.safeParse(args.refund)
	if (!parsed.success) return undefined
	const occurredAt = new Date(parsed.data.created * 1000)
	if (!Number.isFinite(occurredAt.getTime())) return undefined
	return {
		facts: {
			purchaseId: args.purchaseId,
			refundId: parsed.data.id,
			amountCents: parsed.data.amount,
			currency: parsed.data.currency,
		},
		occurredAt: occurredAt.toISOString(),
	}
}
