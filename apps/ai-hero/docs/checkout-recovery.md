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

Do not run apply against production without Joel's explicit approval for that exact session ID.

## Environment

The command runs under bare `tsx`, not inside Next. It reads only the variables it uses, so a clean checkout does not need a full Vercel env pull and does not need a `server-only` stub in `node_modules`.

Dry-run needs:

- `DATABASE_URL`
- `STRIPE_SECRET_TOKEN`

Apply additionally needs:

- `INNGEST_EVENT_KEY`
- `NEXT_PUBLIC_APP_NAME` (the Inngest client id; not transmitted with the event)

`vercel env pull` writes `"[SENSITIVE]"` instead of the value for sensitive variables such as `INNGEST_EVENT_KEY`. The command refuses that placeholder by name before any network call. Lease the real key into the shell instead:

```bash
export INNGEST_EVENT_KEY=$(secrets lease ai-hero::inngest_event_key --ttl 10m | tail -1)
```

The apply-mode Inngest client is pinned to cloud mode (`isDev: false`). It never probes a local Inngest dev server on port 8288, so a running `pnpm dev` cannot swallow the replay.

`STRIPE_WEBHOOK_SECRET` is optional. The recovery path never verifies a webhook signature. When it is unset, `StripePaymentAdapter` logs one harmless `Stripe webhook secret not found` line at construction. Export the secret to silence it.

Missing variables fail with a list of NAMES before any Stripe or database call. Values are never printed.

## Monitoring

Run `docs/checkout-recovery-monitor.sql` as a read-only query. It reports completed paid payment sessions older than 15 minutes with no Purchase. The query is bounded to 100 rows and performs no writes.
