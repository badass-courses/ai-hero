# Desk C5 coupon batches

Off by default. The desk can issue C5 comps without a production database credential. The old support mint route is unchanged.

## Wire contract

All calls are under `/api/commerce/coupon-batches`. Send an expiring desk PAT in `Authorization: Bearer …`. Commerce scopes are not available through self-service PAT minting. A separate server-side desk grant controls `commerce:coupons:mint` and `commerce:coupons:read` for each principal.

1. `POST /preview` with `campaignRef`, `templateId: "c5-comp-v1"`, `template: { productId: "product-s00zs", percentageDiscount: 1, maxUses: 1, deadlineAt }` and `items: [{ intentKey }]`. `deadlineAt` is an absolute, whole-second instant in the next 30 days. The response includes normalized terms, counts, an initial page of verdicts and a confirmation receipt. Preview writes nothing.
2. Confirm the terms. `POST` the same manifest with `previewReceipt` and an `Idempotency-Key` header. The receipt binds the normalized body, desk principal and policy version for five minutes. A `202` means the whole request is durable; follow its `Location` or replay the same key and manifest. A different manifest under the same key conflicts. A replay of an accepted manifest needs no new receipt.
3. `GET /{batchId}?cursor=N` for up to 100 outcomes and aggregate counts. `POST /lookup` with `{ intentKeys: [...] }` for at most 100 keys. A pending item is not unknown. Status and lookup never return redemption codes.
4. `POST /export` with `{ batchId, cursor? }` after completion. Only the initiating desk principal can export, with the read grant and a valid PAT. The response is private and no-store. Codes stop exporting after 24 hours or coupon expiry, whichever comes first. A second batch that references the same intent cannot extend that window.

Codes transfer until spent or expired. The private client submits the code in the body of the existing `/api/coursebuilder/redeem/coupon` free claim, never in a checkout URL or Stripe metadata. The existing C5 `?code=` presentation also resolves the code for the free claim dialog; verify host-level query capture and referrer handling before enabling any link-delivery client. Do not copy codes into receipts, logs or support transcripts. Coupon refs in status are not selectors. The template owns the C5 sold-out bypass; a different product cannot borrow it.

## Enable and stop

Deployment, grants and live minting each need approval. Apply `src/db/migrations/20261126_ai_hero_coupon_batches.sql` through the reviewed schema path. Leave `AIH_COUPON_BATCH_ENABLED` unset and the `ai-hero` row in `AI_CouponBatchControl` absent or disabled until rollout. Store a strong, dedicated `AIH_COUPON_BATCH_SECRET` server-side for preview signing and export encryption. Do not rotate it during an active export window unless losing export access is acceptable; redemption does not depend on the key.

The worker drains at most 100 rows per transaction and uses one DB connection per worker process, separate from checkout. The control row sets `chunkSize` and `paceMs` without a redeploy. Change those before adding concurrency. A `202` batch survives missed wakes; a once-per-minute sweep finds due work. It rechecks the originating expiring PAT, its desk grant and the deadline before minting a chunk.

A single batch over 3,000 and a Pacific day over 4,000 new intents create durable alerts, not refusals. Count new intent keys once in their owning batch’s acceptance day. Track actual minted rows separately. The pager endpoint configured by `AIH_COUPON_BATCH_PAGE_URL` and `AIH_COUPON_BATCH_PAGE_TOKEN` must dedupe requests by `Idempotency-Key` before paging. Confirm that contract before rollout. A missing or failing pager leaves the outbox pending, without holding issuance.

For an immediate stop, set the DB control row’s `enabled` to `0` through the approved operator path. Wait for that write to commit: it shares the transaction fence with admission and minting. A chunk holding the fence can finish before the stop acknowledges, not after. Status, authorized export and existing redemptions stay available. Reconcile the queue before re-enabling. Do not delete dedupe rows, reissue accepted keys through SQL or roll back paid settlement.

## Synthetic proof

Run `src/lib/coupon-batches/*.test.ts` and `src/lib/coupon-mint.mysql.test.ts` with fresh disposable loopback MySQL schemas generated from the app schema. See the guarded cases in `.github/workflows/evergreen-journey-mysql.yaml`. They use fixture PATs and synthetic accounts. No Stripe, customer data, delivery or production access is required. The fixture drain is not a claim about production queue latency or checkout p95.
