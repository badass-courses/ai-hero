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

import { log, serializeError } from "@/server/logger";
import { emitBuyPath } from "@/lib/buy-path/server";
import { purchaseBuyPathContext } from "@/lib/buy-path/read-context";
import type { BuyPathContext } from "@/lib/buy-path/schema";
import { installBuyPathLegacyAliases } from "@/lib/buy-path/legacy-logger";

import { InngestMiddleware } from "inngest";

installBuyPathLegacyAliases();

export const inngestTelemetryMiddleware = new InngestMiddleware({
  name: "Telemetry Middleware",
  init() {
    return {
      onFunctionRun({ ctx, fn }) {
        const functionId = fn.id(fn.name);
        const runId = ctx.runId;
        const eventName =
          ctx.event?.name ?? (ctx as Record<string, unknown>).event_name;
        const txnId = (ctx.event?.data as Record<string, unknown>)?.txnId as
          | string
          | undefined;

        const fnStart = Date.now();

        void log.info("inngest.function.started", {
          functionId,
          eventName,
          runId,
          ...(txnId && { txnId }),
        });

        let context: BuyPathContext | null = null;
        return {
          async transformInput({ ctx: hydrated }) {
            // Observe hydrated input directly; memoized step execution can
            // bypass beforeExecution, but it cannot bypass input hydration.
            const purchaseId = hydrated.event?.data?.purchaseId;
            if (typeof purchaseId !== "string") {
              if (eventName === "commerce/new-purchase-created")
                await log.error("buy_path.context_read_failed", {
                  functionId,
                  runId,
                  reason: "missing_purchase_id",
                });
              return;
            }
            try {
              context = await purchaseBuyPathContext(purchaseId);
              if (!context)
                await log.error("buy_path.context_read_failed", {
                  purchaseId,
                  functionId,
                  runId,
                });
              if (context)
                await emitBuyPath(context, "post_purchase_started", {
                  functionId,
                  runId,
                });
            } catch {
              await log.error("buy_path.context_read_failed", {
                purchaseId,
                functionId,
                runId,
              });
            }
          },
          async finished({ result }) {
            if (context)
              await emitBuyPath(context, "post_purchase_finished", {
                functionId,
                runId,
                durationMs: Date.now() - fnStart,
                outcome: result.error ? "failed" : "ok",
              });
          },
          afterExecution() {
            const durationMs = Date.now() - fnStart;

            void log.info("inngest.function.completed", {
              functionId,
              eventName,
              durationMs,
              runId,
              ...(txnId && { txnId }),
            });
          },

          onFailure({ error }: { error: Error }) {
            const durationMs = Date.now() - fnStart;

            void log.error("inngest.function.failed", {
              functionId,
              eventName,
              durationMs,
              runId,
              ...(txnId && { txnId }),
              error: serializeError(error),
            });
          },
        };
      },
    };
  },
});
