# Paid checkout recovery

AI Hero uses the normal Course Builder checkout handler as its only recovery path. The pinned `@coursebuilder/adapter-drizzle@2.1.2` patch adopts an existing Stripe charge and merchant session when a retry finds the intermediate state. It creates one Purchase and one PurchaseUserTransfer. A second call returns the existing Purchase.

The patch is local because the failing code ships inside the pinned adapter package. Keeping it in `patches/@coursebuilder__adapter-drizzle@2.1.2.patch` changes the live adapter without copying its purchase rules into an app-side reconciler. Remove the patch after the same fix ships upstream and the pinned package is upgraded.

## Operator command

The command accepts one exact Stripe Checkout Session ID. Dry-run is the default.

```bash
pnpm --filter ai-hero checkout:recover \
  --checkout-session-id cs_123
```

Do not put `--` before the flags. pnpm 11 fails with `Unknown argument: --`.

The command reads Stripe and the database, then writes a JSON receipt under `tmp/checkout-recovery/`. It refuses sessions that are not complete paid one-time payments. It also refuses to send a replay when a Purchase already exists.

Apply mode requests one replay of `stripe/checkout-session-completed` through Inngest. The deterministic recovery event ID and the checkout function idempotency key bound duplicate requests. The patched adapter then uses the normal checkout path, including the existing `purchase/created` fulfillment event.

```bash
pnpm --filter ai-hero checkout:recover \
  --checkout-session-id cs_123 \
  --apply
```

A replay inside 24 hours of the original event never runs. The checkout function keys idempotency on the session id, and Inngest spends that key even when the original event produced no run (incident 2026-10-09). So after sending, apply mode asks the Inngest API for the replay's runs for up to a minute. When there are none, it runs the checkout handler directly in this process (`status: fulfilled_direct`, `directReason: replay_produced_no_run`). Without `INNGEST_SIGNING_KEY` it cannot ask; the receipt says so and you rerun with `--direct`.

`--direct` skips the replay and runs the registered `stripe-checkout-session-completed` handler in this process, with the app's own identity, Stripe and Slack providers. It shares its guards with the reconciler below: it re-reads the session, refuses refunded or disputed charges, sessions from another site and zero-total sessions, re-checks for a Purchase, holds when the buyer already has the product, and checks again inside the handler's write step. A dry run with `--direct` applies the same site and total checks, reports `would_fulfill_direct`, and writes nothing. `--direct` needs `NEXT_PUBLIC_APP_NAME`, in dry run too.

```bash
pnpm --filter ai-hero checkout:recover \
  --checkout-session-id cs_123 \
  --direct            # dry run
pnpm --filter ai-hero checkout:recover \
  --checkout-session-id cs_123 \
  --direct --apply
```

Do not run apply against production without Joel's explicit approval for that exact session ID.

## Checkout reconciler

`checkout-reconciler-sweep` runs every 10 minutes. It lists completed Stripe Checkout Sessions from the last 48 hours in one read-only, paginated call that expands each session's charge (`data.payment_intent.latest_charge`). It keeps paid `payment` sessions this app stamped (`metadata.siteName`), skips zero-total sessions the webhook quarantines, and finds the ones with no Purchase 5 minutes after **payment**. Age is measured from the charge's `created` time, not the session's, because a session is created when checkout opens. A session with no Purchase logs `checkout.reconcile.stranded`, and 30 minutes after payment it also logs `checkout.reconcile.fulfill_overdue`. Refunded sessions are logged as `checkout.reconcile.refunded_skipped` and left alone. Disputed sessions are held for a human. If the list hits its 10,000-session cap, the sweep logs `checkout.reconcile.list_truncated`.

Slack alerts go to the default channel **on change, then hourly**. A sweep alerts when a session crosses the 5-minute or 30-minute line since the previous tick. While any session stays stranded or held, the first sweep of each UTC hour repeats the alert. Every tick still logs to Axiom.

### Alert-only by default

The reconciler fulfills nothing until `AIH_CHECKOUT_RECONCILER_AUTO_FULFILL=true` is set in Vercel production env and the app is redeployed. On the first deploy, review what the sweep flags for at least one 48-hour window. A stranded session in alert-only mode is fixed by hand with `checkout:recover --direct` (dry run first).

With auto-fulfill on, the sweep sends `aihero/checkout-reconcile.fulfill-requested` per stranded session. `checkout-reconcile-fulfill` runs the same checkout handler directly and posts a Slack note when it fulfills one. Its idempotency key is `checkout-reconcile:<session id>:<UTC hour>`, distinct from the core function's bare session id. A session that is still stranded gets one new attempt per hour. The function shares the core checkout function's env-scoped `"checkout-purchase-writes"` concurrency key, so a burst of reconciles queues behind the same write limit as the originals.

### Holds

`checkout-reconcile-fulfill` and `--direct` refuse to sell a buyer the same product twice. If the buyer already has a `Valid` or `Restricted` purchase of the product created at or after the session opened, and it is not linked to this checkout (a gift, a coupon redemption, a transfer, or a hand fix after an alert), the run returns `held: buyer_already_has_product`. It writes nothing and alerts. Decide by hand whether to refund the charge or leave it.

### One Purchase per session

Three layers hold it: the re-check before the handler, a guard immediately before the adapter write (it re-reads the charge and the buyer's purchases with the handler's resolved user and product), and the adapter's own transaction (a locking read on the charge plus the unique `MerchantCharge.identifier`, verified on production). `src/lib/checkout-reconcile/fulfill.mysql.test.ts` races the original run against the reconciler on real MySQL.

### Stopping it

- **Instant:** pause `checkout-reconcile-fulfill` in the Inngest dashboard and choose **Cancel immediately**. The default option ("Pause immediately") holds in-flight runs and resumes them later. Events that arrive while it is paused are marked skipped and are not run on resume. The sweep requests again within the hour.
- **Durable:** unset `AIH_CHECKOUT_RECONCILER_AUTO_FULFILL` and redeploy. The sweep keeps logging and alerting. A fulfill run already queued sees auto-fulfill off and returns `disabled`. Because the key is hourly, that run blocks its session for under an hour, not 24.
- **Detection off:** pause `checkout-reconciler-sweep` too.

## Environment

The command runs under bare `tsx`, not inside Next. It reads only the variables it uses, so a clean checkout does not need a full Vercel env pull and does not need a `server-only` stub in `node_modules`.

Dry-run needs:

- `DATABASE_URL`
- `STRIPE_SECRET_TOKEN`

Apply additionally needs:

- `INNGEST_EVENT_KEY`
- `NEXT_PUBLIC_APP_NAME` (the Inngest client id; not transmitted with the event)
- `INNGEST_SIGNING_KEY`, optional, to confirm the replay produced a run

Direct fulfillment loads the app's own handler and providers, which validate the full app environment on import. Use a full production env file, with `INNGEST_EVENT_KEY` leased as below, and keep the `--conditions=react-server` flag the package script passes.

`vercel env pull` writes `"[SENSITIVE]"` instead of the value for sensitive variables such as `INNGEST_EVENT_KEY`. The command refuses that placeholder by name before any network call. Lease the real key into the shell instead:

```bash
export INNGEST_EVENT_KEY=$(secrets lease ai-hero::inngest_event_key --ttl 10m | tail -1)
```

The apply-mode Inngest client is pinned to cloud mode (`isDev: false`). It never probes a local Inngest dev server on port 8288, so a running `pnpm dev` cannot swallow the replay.

`STRIPE_WEBHOOK_SECRET` is optional. The recovery path never verifies a webhook signature. When it is unset, `StripePaymentAdapter` logs one harmless `Stripe webhook secret not found` line at construction. Export the secret to silence it.

Missing variables fail with a list of NAMES before any Stripe or database call. Values are never printed.

## Monitoring

Run `docs/checkout-recovery-monitor.sql` as a read-only query. It reports completed paid payment sessions older than 15 minutes with no Purchase. The query is bounded to 100 rows and performs no writes.
