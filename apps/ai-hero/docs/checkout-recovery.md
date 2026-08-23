# Paid checkout recovery

AI Hero uses the normal Course Builder checkout handler as its only recovery path. The pinned `@coursebuilder/adapter-drizzle@2.1.2` patch adopts an existing Stripe charge and merchant session when a retry finds the intermediate state. It creates one Purchase and one PurchaseUserTransfer. A second call returns the existing Purchase.

The patch is local because the failing code ships inside the pinned adapter package. Keeping it in `patches/@coursebuilder__adapter-drizzle@2.1.2.patch` changes the live adapter without copying its purchase rules into an app-side reconciler. Remove the patch after the same fix ships upstream and the pinned package is upgraded.

## Operator command

The command accepts one exact Stripe Checkout Session ID. Dry-run is the default.

```bash
pnpm --filter ai-hero checkout:recover -- \
  --checkout-session-id cs_123
```

The command reads Stripe and the database, then writes a JSON receipt under `tmp/checkout-recovery/`. It refuses sessions that are not complete paid one-time payments. It also refuses to send a replay when a Purchase already exists.

Apply mode requests one replay of `stripe/checkout-session-completed` through Inngest. The deterministic recovery event ID and the checkout function idempotency key bound duplicate requests. The patched adapter then uses the normal checkout path, including the existing `purchase/created` fulfillment event.

```bash
pnpm --filter ai-hero checkout:recover -- \
  --checkout-session-id cs_123 \
  --apply
```

Do not run apply against production without Joel's explicit approval for that exact session ID.

## Monitoring

Run `docs/checkout-recovery-monitor.sql` as a read-only query. It reports completed paid payment sessions older than 15 minutes with no Purchase. The query is bounded to 100 rows and performs no writes.
