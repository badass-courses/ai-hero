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

`--direct` skips the replay and runs the registered `stripe-checkout-session-completed` handler in this process, with the app's own identity, Stripe and Slack providers. It shares its guards with the reconciler below: it re-reads the session, refuses refunded or disputed charges, re-checks for a Purchase, and checks again inside the handler's write step. A dry run with `--direct` reports `would_fulfill_direct` and writes nothing.

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

`checkout-reconciler-sweep` runs every 10 minutes. It lists completed Stripe Checkout Sessions from the last 48 hours (read-only), keeps paid `payment` sessions this app stamped (`metadata.siteName`), skips zero-total sessions the webhook quarantines, and finds the ones older than 5 minutes with no Purchase. For each it logs `checkout.reconcile.stranded` and posts one Slack alert per sweep to the default channel. Refunded sessions are logged as `checkout.reconcile.refunded_skipped` and left alone. Disputed sessions are held for a human.

It then sends `aihero/checkout-reconcile.fulfill-requested` per session. `checkout-reconcile-fulfill` runs the same checkout handler directly, under its own idempotency key `checkout-reconcile:<session id>`, and posts a Slack note when it fulfills one. A session still stranded after 30 minutes logs `checkout.reconcile.fulfill_overdue` and the alert asks for `--direct --apply`.

One Purchase per session holds in three layers: the re-check before the handler, a guard immediately before the adapter write, and the adapter's own transaction (a locking read on the charge plus the unique `MerchantCharge.identifier`). `src/lib/checkout-reconcile/fulfill.mysql.test.ts` races the original run against the reconciler on real MySQL.

Kill switch: set `AIH_CHECKOUT_RECONCILER_AUTO_FULFILL_DISABLED=true` in Vercel production env and redeploy. The sweep keeps alerting and fulfills nothing. Unset it to restore auto-fulfill (the default).

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
