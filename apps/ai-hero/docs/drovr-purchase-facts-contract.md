# Purchase facts contract

Agreed by the AI Hero payload and drovr pitch-facts lanes on 2026-09-30, approved by Hawk before implementation. Build-only packet: no production access or deployment. Deploy AI Hero before or together with a compatible drovr decoder. Old payloads remain valid.

## `purchase.recorded`

Existing `productId` and journey-specific `sameOffer` stay unchanged. Add optional fields:

- `purchaseId`: purchase row ID, shared by offer-primary and buyer-stop copies. Deduplicate attribution by this ID, not receipt count.
- `couponId`: linked purchase coupon, when present.
- `priceClass`: `team | coupon | ppp | full`. Precedence: nonpaying team-seat excluded, paid team bulk, coupon linkage, Restricted PPP, known no-coupon USD 29900 Crash Course charge. Unknown is omitted, never forced full.
- `amountCents`, `currency`: successful paid captured Stripe charge's `amount_captured` and lowercase currency. No DB-total rounding or inferred currency. Missing/unverified charge facts are omitted.
- `couponIssueContactId`, `couponIssuedAt`, `couponExpiresAt`: validated eoj-coupon issue contact and coupon authority timestamps, when available.

Attribution uses `couponIssueContactId`; it does not route events. Preserve the existing offer-contact primary and different-buyer stop copy. Only the existing evergreen primary carries `sameOffer`; no new guard or lifecycle meaning.

## `purchase.refunded`

Payload: `{ purchaseId, refundId, amountCents, currency }`. Each event is one succeeded Stripe refund, timestamped by its provider creation time. Refund IDs deduplicate repeated observations; amounts are deltas, never cumulative charge snapshots. Pending/failed refunds do not reduce revenue. Route to the authority contact directory only, not sending journeys. Refunds do not restart pitches or change entitlement handling.

The observer runs beside the existing `commerce/refund-processed` function. It lists all refund pages for that charge, then records each succeeded refund against existing purchase-capture contacts. This observes that trigger, not every out-of-band Stripe refund or a later pending-to-succeeded change without another trigger. Those unobserved facts remain unknown; no completeness claim or production backfill is made here.

## Boundaries

Pure boundary parsers own the wire facts; Inngest owns retry/step persistence. No new lifecycle or Effect runtime is introduced. The checkout, purchase identity resolver, journey routing, entitlements, and provider mutation paths stay unchanged. The repo uses both Effect 3 and Effect 4; its existing mirror is not version-verified, so this packet does not edit Effect code.

Checks cover old/missing payloads, captured cents differing from rounded DB totals, category precedence, nonpaying seats, unknown prices, sameOffer routing, refund status/pagination, and stable refund identity.
