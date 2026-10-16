import { log } from '@/server/logger'
import { buyPathSchema, type BuyPathContext, type BuyPathEvent } from './schema'

/** Explicit projection prevents arbitrary provider payloads and PII entering events. */
export async function emitBuyPath(
	context: BuyPathContext,
	step: BuyPathEvent['step'],
	extra: Partial<
		Pick<
			BuyPathEvent,
			| 'outcome'
			| 'durationMs'
			| 'attempt'
			| 'functionId'
			| 'runId'
			| 'chargeId'
			| 'amountCents'
			| 'decisionKind'
			| 'field'
			| 'source'
		>
	> = {},
) {
	const parsed = buyPathSchema.safeParse({
		telemetrySchemaVersion: 1,
		occurredAt: new Date().toISOString(),
		buyPathId: context.buyPathId,
		preSessionId: context.preSessionId ?? null,
		purchaseId: context.purchaseId,
		productId: context.productId,
		userId: context.userId,
		step,
		outcome: 'ok',
		durationMs: 0,
		sincePaymentMs: context.paymentAt
			? Math.max(0, Date.now() - context.paymentAt)
			: null,
		source: 'server',
		chargeId: context.chargeId ?? null,
		...extra,
	})
	if (!parsed.success) {
		await log.error('buy_path.invalid_event', { step, field: 'schema' })
		return
	}
	await log[extra.outcome === 'failed' ? 'error' : 'info'](
		`buy_path.${step}`,
		parsed.data,
	)
}
