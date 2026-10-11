import { z } from 'zod'

export const buyPathSteps = [
	'pricing_viewed',
	'checkout_created',
	'redirect_to_stripe',
	'webhook_received',
	'purchase_created',
	'entitlements_granted',
	'post_purchase_started',
	'post_purchase_finished',
	'client_returned',
	'client_polling',
	'purchase_visible',
	'destination_rendered',
	'invariant_checked',
	'invariant_failed',
] as const
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,255}$/)
export const buyPathIdSchema = z
	.string()
	.regex(/^(cs_[a-zA-Z0-9_]+|pre_[a-f0-9-]{36})$/)
export const buyPathSchema = z
	.object({
		telemetrySchemaVersion: z.literal(1),
		occurredAt: z.string().datetime(),
		buyPathId: buyPathIdSchema,
		preSessionId: z
			.string()
			.regex(/^pre_[a-f0-9-]{36}$/)
			.nullable()
			.default(null),
		purchaseId: id.nullable(),
		productId: id.nullable(),
		userId: id.nullable(),
		step: z.enum(buyPathSteps),
		outcome: z.enum(['ok', 'failed', 'skipped']),
		durationMs: z.number().finite().nonnegative(),
		sincePaymentMs: z.number().finite().nonnegative().nullable(),
		// Inngest prefixes IDs with human-readable function names (including spaces).
		functionId: z
			.string()
			.min(1)
			.max(255)
			.regex(/^[^\x00-\x1F\x7F]+$/)
			.optional(),
		runId: id.optional(),
		attempt: z.number().int().min(0).max(45).optional(),
		chargeId: id.nullable().optional(),
		amountCents: z.number().int().nonnegative().optional(),
		decisionKind: id.optional(),
		field: z
			.enum([
				'purchase',
				'status',
				'entitlements',
				'charge',
				'amount',
				'decision',
			])
			.optional(),
		source: z.enum(['server', 'client']),
	})
	.strict()
export type BuyPathEvent = z.infer<typeof buyPathSchema>
export type BuyPathContext = Pick<
	BuyPathEvent,
	'buyPathId' | 'purchaseId' | 'productId' | 'userId'
> & {
	paymentAt?: number | null
	preSessionId?: string | null
	chargeId?: string | null
}
export const clientBuyPathSchema = z
	.object({
		buyPathId: buyPathIdSchema,
		productId: id.optional(),
		step: z.enum([
			'pricing_viewed',
			'redirect_to_stripe',
			'client_returned',
			'client_polling',
			'purchase_visible',
			'destination_rendered',
		]),
		durationMs: z.number().finite().min(0).max(86_400_000),
		attempt: z.number().int().min(0).max(45).optional(),
		outcome: z.enum(['ok', 'failed', 'skipped']),
	})
	.strict()
export type ClientBuyPathEvent = z.infer<typeof clientBuyPathSchema>
