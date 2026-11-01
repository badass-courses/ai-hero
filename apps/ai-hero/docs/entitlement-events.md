# Included-product entitlement events for drovr

A C5 seat (`product-s00zs`) includes the AI Coding Crash Course (`product-ma254`) under `c5-includes-crash-course-v1` (`src/lib/included-product-policy.ts`). AI Hero tells drovr about each included grant as `entitlement.granted`, and about its end as `entitlement.revoked`. drovr's offer engine (drovr #3411, slice S1b) reads both as ownership, with no money. A C5 holder is then never pitched the crash course the seat includes. Joel, 2026-10-20: "exclude c5 purchasers from crash course pitch later since they get it".

## The flag

`AIH_ENTITLEMENT_EVENTS_ENABLED` defaults to **off**. `on`, `true` or `1` turn it on (case-insensitive, surrounding spaces ignored). It is read only by `entitlementEventsEnabled` (`src/lib/included-product-entitlement-events.ts`). While it is off, fulfilment and transfers write nothing new. Turn it on only after drovr #3411 deploys. Before that deploy, drovr logs the events but no ownership read takes them.

## What is recorded, and when

- **Derived from the rows.** `recordIncludedProductEntitlementEvents` reads a purchase's included content-access rows and records what is true now. A live row is a grant and a soft-deleted row is a revoke. Discord role rows are never reported.
- **Grant and transfer.** `grantIncludedProductEntitlements` and `transferIncludedProductEntitlements` call it after their transaction commits. A transfer is a revoke for the source and a grant for the target. A failure is logged as `included_product.entitlement_events_failed` and never fails or rolls back fulfilment. The next reconcile of the purchase, or the backfill, records what was missed.
- **Refunds and operator revokes** soft-delete through the shared entitlement helpers, which do not call the recorder. Their revokes are recorded by the next reconcile of that purchase or by a backfill run. Until then drovr still counts the grant as owned, so the holder is not pitched.
- **Grant ids.** `entitlementId` is the `c5_cc_…` row id. drovr ends a grant id for good at its first revoke, so a row restored by a transfer back to its prior owner is granted as `<row id>:<transferId>`. Each restore appends `{ transferId, restoredAt }` to the row's `metadata.restorations`, and never overwrites it. The live path and the backfill therefore derive the same ids, and a row restored twice still revokes its earlier restored grant.
- **The road** is `purchase.recorded`'s. A holder with an AI Hero contact gets a ContactEvent (`writeEntitlementRecordedContactEvents`) whose dispatch is awaited, as a purchase's is. Delivery and the outbox own retries from there. The event goes to `org-aihero`'s `contact-directory` journey, which drovr's ownership read finds. An evergreen copy reaches an owned pitch actor through owner fan-out, where evergreen v10's grant exit folds it. A holder drovr knows only by email is resolved there (`resolve_contacts`) and posted directly, as an uncontacted buyer's purchase is.

## Wire shape

```text
entitlement.granted  { entitlementId, productId, viaProductId?, bundlePolicy? }
entitlement.revoked  { entitlementId }
idempotencyKey       aihero:ai-hero:entitlement.<granted|revoked>:<entitlementId>
```

No amount and no price. `src/lib/included-product-entitlement-events.test.ts` checks both payloads against a copy of drovr's decoder shape.

drovr's ingress is log-first, and its ownership read takes every event of the contact, whatever the journey. A contact with no directory or evergreen actor answers 409 `cold-start-unhandled` on that copy, and delivery counts it rejected, as it does a `purchase.recorded` copy there. The event is still in drovr's log, so the grant still counts.

## Backfill

`scripts/entitlement-events-backfill.ts` posts `entitlement.granted` for every live included grant and `entitlement.revoked` for every ended one. It skips facts the ContactEvent mirror already recorded and holders with no email. It resolves the rest in drovr and posts only the resolved holders, under the live keys, so a rerun changes nothing in drovr. Rows are read in pages of 500, and posts are paced at about 2 per second.

```sh
# Dry run (default): reads, resolves and prints counts. Posts nothing.
tsx scripts/entitlement-events-backfill.ts

# Post, after the desk's word. --snapshot writes a 0600 file of
# (entitlementId, change, drovrContactId) before the first post.
tsx scripts/entitlement-events-backfill.ts --apply --snapshot <path> [--limit <n>]
```

It needs `DATABASE_URL`, `DROVR_API_KEY_ORG_AIHERO`, and `DROVR_SHADOW_INGEST_URL` or `DROVR_API_BASE_URL`. Stdout is one JSON line of counts: `alreadyRecorded`, `noEmail`, `facts`, `granted`, `revoked`, `resolved`, `missing`, `conflict`, `posted`, `accepted`, `rejected`, and `rejectedBy` by status and problem type. It exits non-zero on a transport failure and keeps what was already posted.

## Rollout

1. drovr #3411 deploys.
2. Set `AIH_ENTITLEMENT_EVENTS_ENABLED=on` in production and redeploy.
3. Run the backfill dry run and report the counts to the desk.
4. Run `--apply` on the desk's word.

Rollback: unset the flag. Events already posted stay in drovr's log, which is correct: they are true.
