# Buy-path telemetry

`src/lib/buy-path/schema.ts` owns the version 1 contract. Events use `buy_path.<step>`. IDs, timings, outcomes and small enum-like fields only. Provider objects, email, names, error messages and customer-supplied labels must not enter this contract. Existing C5, geo, contact and post-purchase event names remain unchanged. A path-scoped SDK logger adapter retains original output and adds identifier-only structured aliases for webhook, flow-start and purchase-completed events. `purchase_created` is observed when the SDK logs the completed purchase write, not when the later follow-up workflow eventually starts.

`buyPathId` is the Stripe Checkout Session ID. Pricing emits a `pre_` UUID stored in a same-site cookie. `checkout_created` links the pre-session ID to the session. Purchase, product and user IDs are nullable until the server knows them. Anonymous pricing knows the product but not the user. Purchase and charge IDs are projected from server rows, never accepted from the client. `occurredAt` is the observation time. `sincePaymentMs` uses the Stripe charge's creation time, or is null when there is no authoritative payment clock. It never uses the pricing or session creation time as payment time.

## Client interface

Import `createBuyPathLogger` from `src/lib/buy-path/client.ts`. Call it once per mounted post-purchase screen with the checkout session ID. It returns `emit(step, { attempt?, durationMs?, outcome? })`.

- `client_returned`: mount after returning from Stripe.
- `client_polling`: once after each attempt. Attempts range from 0 to 45. The helper caps at 46 observations. Without an explicit duration, `durationMs` is time spent on this mounted screen, allowing stuck-polling alerts.
- `purchase_visible`: the purchase is available to this browser.
- `destination_rendered`: the destination has mounted, not merely when the server sends a redirect.

`BuyPathDestinationBeacon` is a null-rendering adapter for existing screens. A redesign can call the helper directly. Transport uses a JSON beacon with a keepalive fetch fallback. Delivery is best effort. An absent client observation is a gap, not proof the buyer failed.

Lifecycle sketch in XState v5 terms: `pricing -> redirecting -> processing -> visible -> rendered`, with `processing -> stalled` after the existing bounded retry budget. The helper only observes these transitions. It does not own timers, retries, navigation or a second lifecycle machine.

The ingest route validates a strict client subset, caps body size, checks same origin and uses the shared Redis sliding-window limiter in production. Redis failure returns 503. Development uses a bounded local limiter for the isolated commerce rig. A signed, one-hour, HTTP-only cookie issued by checkout binds session events to server-known identity. It uses the existing auth secret; no new environment setting is needed. Pricing observations require the matching pre-session cookie and a real public product. Client observations remain untrusted measurements, not purchase or access authority. Cookie expiry, a second checkout replacing the cookie, browser blocking and visiting a copied return URL can produce client gaps.

`redirect_to_stripe` from the server means the checkout route issued its Stripe redirect or login handoff. A client observation on pagehide means a submitted checkout left its pricing screen. Neither claims Stripe rendered. The trace links these through the pre-session ID and distinguishes `source`.

## Readback and function tracing

The post-purchase workflow ends with a ten-second settling delay and a fresh read of purchase status, active purchase-sourced entitlements, and the Stripe charge amount against purchase total in integer cents. A field failure emits error-level `buy_path.invariant_failed`. Team orders have no individual entitlement expectation. Coupon redemptions without a Stripe session do not manufacture a buy-path ID. Parallel email and Discord jobs are not prerequisites for access and may finish after this access readback.

`purchaseDecisionInvariantChecks` is the desk's explicit hook for the new PurchaseDecision adapter. It stays empty until that table lands. The check emits a skipped decision observation, not a decision pass. No legacy decision fields are read by this check.

Inngest middleware emits started and finished observations for purchase-related functions. `finished` uses Inngest's final-response hook, not a step checkpoint. Starts can repeat when an execution resumes. Duration is the execution segment, not a fabricated whole-run duration; the ordered timeline supplies elapsed wall time. Missing correlation emits `buy_path.context_read_failed` and is never silently called healthy.

## Monitor definitions for desk application

**Axiom monitors on Vercel request logs are the first alarm. They must run outside Inngest.** The Inngest invariant is a second line: it verifies persisted state once execution resumes. It cannot detect a scheduler-wide stall while it is itself queued. Neither the invariant nor the reconciler may own the outage clock, monitor evaluation or notification delivery.

These are Axiom monitor definitions only. The desk configures their schedule and notification target in Axiom. This PR does not create or enable monitors.

| Name                                                | Condition                                                                                                                                                                                                                                              | Suggested window |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Buy path fulfillment absent after 10 minutes | A Vercel request log named `stripe.webhook.checkout.session.completed` (or `buy_path.webhook_received`) has no `purchase.flow.started` or `buy_path.purchase_created` for the same session within ten minutes. Evaluate in Axiom, not in an Inngest cron. | 24-hour lookback, 1-minute evaluation |
| Buy path reconciler heartbeat absent | No Vercel `checkout.reconcile.sweep` log in the last 25 minutes, including when the whole source is empty. Evaluate and notify from Axiom. | 25-minute lookback, 1-minute evaluation |
| Buy path invariant failed                           | Any `buy_path.invariant_failed`, grouped by field                                                                                                                                                                                                      | 5 minutes        |
| Buy path webhook to purchase over 60 seconds        | Same session's first purchase-created observation minus first webhook-received observation exceeds 60,000 ms. Also alert on webhooks older than 60 seconds with no purchase observation. Exclude the youngest minute from missing-purchase evaluation. | 10 minutes       |
| Buy path payment to destination p95 over 30 seconds | p95 of non-null `sincePaymentMs` at client `destination_rendered` exceeds 30,000 ms. Count distinct sessions, not reloads. Missing client events need the separate polling/gap review, not a zero duration.                                            | 15 minutes       |
| Buy path client polling over 45 seconds             | Client polling's screen-elapsed `durationMs` exceeds 45,000 ms                                                                                                                                                                                         | 5 minutes        |
| Buy path checkout missing correlation               | `buy_path.checkout_created` with missing or empty `buyPathId`                                                                                                                                                                                          | 5 minutes        |

For the Vercel sink, start with `['vercel'] | where ['vercel.projectName'] == 'ai-hero' | extend p=parse_json(tostring(message))`, then filter on `tostring(p.event)`. Server events retain Axiom-compatible names and structured fields. Do not group alerts by email or include provider payloads.

For the ten-minute alarm, normalize the session with `tostring(coalesce(p.buyPathId, p.checkoutSessionId, p.sessionId))`. `txnId` is a fallback only when both sides carry that same transaction ID; never join one side's transaction ID to the other's session ID. Group by the normalized session, take the earliest webhook time, and count matching flow-start or purchase-created logs. Alert when the webhook is at least ten minutes old and that count is zero. Request-side webhook evidence remains available while Inngest is stalled.

For the heartbeat, query the last 25 minutes and `summarize sweepCount=countif(tostring(p.event) == 'checkout.reconcile.sweep')`. Alert on `sweepCount == 0`. Configure source-empty/no-data behavior to alert rather than treating a missing row as healthy. The heartbeat producer may run on Inngest; its independent Axiom absence detector must not.

Before applying either monitor, validate its session join and zero-data behavior with request-log fixtures. Normal traffic, a webhook with a matching flow, an unmatched webhook older than ten minutes, and a 25-minute heartbeat silence must produce the expected verdicts. A positive reconciler heartbeat does not prove purchases are fulfilled.

## Verification and rollout

Run the buy-path contract tests, existing webhook and post-purchase contract tests, app typecheck, and an isolated paid commerce-rig checkout. Inspect the ordered trace rather than treating a paid Stripe session as access proof. Local rig logs do not automatically reach Axiom; use the operator CLI's local-file mode for that isolated proof. An API-driven rig checkout skips the pricing UI and must report that gap rather than synthesizing a view.

Merge and deploy only after the desk reviews the candidate. There is no new feature flag. Apply monitors separately. Roll back by reverting the telemetry commit; no schema migration or provider configuration needs reversal. Enable the PurchaseDecision hook in a separate reviewed change after the table lands.
