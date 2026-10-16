import { logger, setLogger } from '@coursebuilder/utils/logger'
import { log } from '@/server/logger'
import { emitBuyPath } from './server'

const id = (value: unknown) =>
	typeof value === 'string' && /^[a-zA-Z0-9_-]{1,255}$/.test(value)
		? value
		: null
/** Keep the SDK's original output and add structured aliases only on this path. */
export function installBuyPathLegacyAliases() {
	if (Object.hasOwn(logger, '__buyPathAliasesInstalled')) return
	Object.defineProperty(logger, '__buyPathAliasesInstalled', { value: true })
	const original = logger.info.bind(logger)
	setLogger({
		info: (event, attributes) => {
			original(event, attributes)
			if (
				!(
					event === 'stripe.webhook.checkout.session.completed' ||
					event.startsWith('purchase.flow.') ||
					event === 'purchase.completed'
				)
			)
				return
			const attrs: Record<string, unknown> = attributes ?? {}
			const checkoutSessionId =
				id(attrs.checkoutSessionId) ?? id(attrs.sessionId)
			// Whitelist identifiers, never copy arbitrary SDK attributes (which can contain PII).
			const fields = {
				txnId: id(attrs.txnId),
				checkoutSessionId,
				sessionId: checkoutSessionId,
				purchaseId: id(attrs.purchaseId),
				productId: id(attrs.productId),
				userId: id(attrs.userId),
			}
			void log.info(event, fields)
			if (
				event === 'purchase.completed' &&
				checkoutSessionId?.startsWith('cs_')
			)
				void emitBuyPath(
					{
						buyPathId: checkoutSessionId,
						purchaseId: fields.purchaseId,
						productId: fields.productId,
						userId: fields.userId,
					},
					'purchase_created',
				)
		},
	})
}
