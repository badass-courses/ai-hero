/**
 * Inngest telemetry middleware, automatic function observability.
 *
 * Emits structured Axiom logs for every function start, completion, and
 * failure. No per-function instrumentation needed.
 *
 * Logged events:
 *   inngest.function.started   — { functionId, eventName, runId }
 *   inngest.function.completed — { functionId, eventName, durationMs, runId }
 *   inngest.function.failed    — { functionId, eventName, durationMs, error, runId }
 *
 * The runId is Inngest's run ID, which can be correlated with the
 * Inngest dashboard. If the event includes a txnId (from the Stripe
 * webhook flow), it's included for end-to-end purchase tracing.
 *
 * Note: Do not attempt to wrap step.run() in transformInput. Inngest passes
 * `steps` here as prior step state, not the step tooling object. A previous
 * implementation called `steps.run.bind(steps)`, which crashed every function
 * at runtime with `Cannot read properties of undefined (reading 'bind')`.
 *
 * @module inngest-telemetry-middleware
 */

import { log, serializeError } from '@/server/logger'
import { emitBuyPath } from '@/lib/buy-path/server'
import {
	readPurchaseBuyPathContext,
	type PurchaseBuyPathRead,
} from '@/lib/buy-path/read-context'
import type { BuyPathContext } from '@/lib/buy-path/schema'
import { installBuyPathLegacyAliases } from '@/lib/buy-path/legacy-logger'

import { InngestMiddleware } from 'inngest'

installBuyPathLegacyAliases()

export const inngestTelemetryMiddleware = new InngestMiddleware({
	name: 'Telemetry Middleware',
	init() {
		return {
			onFunctionRun({ ctx, fn }) {
				const functionId = fn.id(fn.name)
				const runId = ctx.runId
				const eventName =
					ctx.event?.name ?? (ctx as Record<string, unknown>).event_name
				const txnId = (ctx.event?.data as Record<string, unknown>)?.txnId as
					| string
					| undefined

				const fnStart = Date.now()

				void log.info('inngest.function.started', {
					functionId,
					eventName,
					runId,
					...(txnId && { txnId }),
				})

				let purchaseId: unknown = ctx.event?.data?.purchaseId
				let context: BuyPathContext | null = null
				let contextRead: PurchaseBuyPathRead | undefined
				return {
					transformInput({ ctx: hydrated }) {
						// Initial metadata can be partial. Observe input without
						// returning/replacing the strongly typed execution context.
						purchaseId = hydrated.event?.data?.purchaseId
					},
					async beforeExecution() {
						if (typeof purchaseId !== 'string') return
						try {
							contextRead = await readPurchaseBuyPathContext(purchaseId)
							context = contextRead.context
							if (context)
								await emitBuyPath(context, 'post_purchase_started', {
									functionId,
									runId,
								})
						} catch (error) {
							// Telemetry must not fail the business function.
							contextRead = { reason: 'threw', context: null, error }
						}
					},
					async finished({ result }) {
						// Final responses only, not every step execution. The SDK can
						// repeat this hook on retries/parallel final responses.
						if (contextRead && contextRead.reason !== 'checkout') {
							const data = {
								purchaseId,
								functionId,
								runId,
								reason: contextRead.reason,
							}
							if (contextRead.reason === 'threw') {
								await log.error('buy_path.context_read_failed', {
									...data,
									error: serializeError(contextRead.error),
								})
							} else {
								await log.info('buy_path.context_unavailable', data)
							}
						}
						if (context)
							await emitBuyPath(context, 'post_purchase_finished', {
								functionId,
								runId,
								durationMs: Date.now() - fnStart,
								outcome: result.error ? 'failed' : 'ok',
							})
					},
					afterExecution() {
						const durationMs = Date.now() - fnStart

						void log.info('inngest.function.completed', {
							functionId,
							eventName,
							durationMs,
							runId,
							...(txnId && { txnId }),
						})
					},

					onFailure({ error }: { error: Error }) {
						const durationMs = Date.now() - fnStart

						void log.error('inngest.function.failed', {
							functionId,
							eventName,
							durationMs,
							runId,
							...(txnId && { txnId }),
							error: serializeError(error),
						})
					},
				}
			},
		}
	},
})
