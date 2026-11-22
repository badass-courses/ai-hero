import { z } from 'zod'

/**
 * What createCoupon accepts from a browser. It used to take the raw input,
 * gated only by create Content (which contributors hold), and spread it into
 * the insert: unlimited quantity, any discount up to 100%, default coupons and
 * special-credit coupons that grant entitlements (security desk sec-049).
 * Bounds sit above every batch the admin form has made (300 codes, 100% off,
 * 250 max uses). Kept out of coupons-query.ts, a 'use server' module, which
 * may export only async functions.
 */
export const CreateCouponInputSchema = z.object({
	quantity: z
		.string()
		.regex(/^\d+$/)
		.refine((value) => Number(value) >= 1 && Number(value) <= 1000, {
			message: 'quantity must be 1 to 1000',
		}),
	maxUses: z.coerce
		.number()
		.int()
		.refine((value) => value === -1 || (value >= 1 && value <= 100_000), {
			message: 'maxUses must be -1 or 1 to 100000',
		}),
	expires: z.date().optional(),
	restrictedToProductId: z.string().optional(),
	discountType: z.enum(['percentage', 'fixed']).default('percentage'),
	percentageDiscount: z
		.string()
		.refine(
			(value) =>
				Number.isFinite(Number(value)) &&
				Number(value) > 0 &&
				Number(value) <= 1,
			{ message: 'percentageDiscount must be above 0 and at most 1' },
		)
		.optional(),
	amountDiscount: z.number().int().min(1).max(1_000_000).optional(),
	status: z.number().default(1),
	default: z.boolean().default(false),
	fields: z.record(z.string(), z.any()).default({}),
})
