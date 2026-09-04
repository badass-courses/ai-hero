import { z } from 'zod'

export const LIVE_PURCHASE_LIMIT = 100
export const MAX_PURCHASE_LIMIT = 500

export const SerializedPurchaseTickerHitSchema = z.object({
	id: z.string().min(1),
	createdAt: z.string().datetime(),
	amount: z.number().finite().positive(),
	productName: z.string(),
	productId: z.string().min(1),
	country: z
		.string()
		.regex(/^[A-Z]{2}$/)
		.nullable(),
	userName: z.string().nullable(),
	userEmail: z.string().nullable(),
	userImage: z.string().nullable(),
	city: z.string().min(1).nullable(),
	region: z.string().min(1).nullable(),
	lat: z.number().finite().nullable(),
	lng: z.number().finite().nullable(),
	isTeam: z.boolean(),
	seats: z.number().int().min(2).nullable(),
})

export const SalesGlobePurchasesResponseSchema = z.object({
	purchases: z.array(SerializedPurchaseTickerHitSchema),
})

export type SerializedPurchaseTickerHit = z.infer<
	typeof SerializedPurchaseTickerHitSchema
>

export type PurchaseTickerHit = Omit<
	SerializedPurchaseTickerHit,
	'createdAt'
> & {
	createdAt: Date
}

export type AdminGlobeProductOption = Readonly<{
	id: string
	name: string
}>

export function serializePurchaseTickerHit(
	hit: PurchaseTickerHit
): SerializedPurchaseTickerHit {
	return {
		...hit,
		createdAt: hit.createdAt.toISOString(),
	}
}
