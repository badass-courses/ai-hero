# Newsletter reporting off Kit

## Source inventory

| Source | Readers | Meaning before the flag |
| --- | --- | --- |
| `src/lib/kit-data.ts`: listBroadcasts, getBroadcastStats, getBroadcastClicks, getBroadcastsWithClicks | `src/lib/analytics/providers/newsletter.ts`, via analytics engine | Completed Kit broadcasts, account recipients, opens, link clicks and unsubscribes. Not drovr sends. Metadata listing also includes drafts. |
| newsletter.getEmailCampaignAttribution | `/api/analytics?surface=attribution/email-campaigns`; analytics agent/chat and API prompt examples in admin analytics | Kit top-of-funnel joined by aihero.dev shortlink slug to local clicks, signups and purchase attribution. Legacy revenue sums a purchaser's paid purchases. |
| newsletter.getEmailCampaignAttributionStrict | `/api/analytics?surface=attribution/email-campaigns/strict`; analytics agents | Same Kit top-of-funnel; purchase-field shortlink attribution, with optional product filter. |
| `src/lib/kit-data.ts`: getTotalSubscribers | `SubscriberCount`: home hero, skills subscribe, post CTA, server MDX/landing body and primary newsletter title | Active Kit account subscriber total, cached 30 minutes; null/error falls back to existing copy. This is not a drovr active-subscriber count. |

No newsletter reporting job or Slack reporting message consumes kit-data in the source inventory. The Slack approval response reads drovr status already and belongs to the producer owner; this change does not touch it.

## Scope decision

The public count is explicitly outside this change. It is on launch sales surfaces, no measured static historical count is approved, and changing the number or label needs separate approval. `SubscriberCount` and `getTotalSubscribers` remain unchanged and **uncovered**. Therefore this PR does not claim a Kit outage breaks no public page. Missing drovr capability: **read-only active-subscriber total per tenant**, with explicit scope and unavailable semantics. Once supplied, the swap is a one-component change behind a flag, subject to approval.

### Public count (K31), dark

drovr now serves `GET /audience-total`: `{ asOf, tenantId, total }` for the authenticated tenant, from a census whose `asOf` is the scan start and can be about 42 hours old. Refusals are RFC 9457 problems, `AudienceTotalForbidden` (403) and `AudienceTotalUnavailable` (503); missing evidence is never zero.

`AIH_SUBSCRIBER_COUNT_OWNED_ENABLED=true` makes `SubscriberCount` read that total through `src/lib/subscriber-count-owned.ts`, with the same tenant credentials as reporting, a five-second timeout and the Kit read's 30-minute cache. Label, rounding and the `< 1000` plausibility floor are unchanged. A missing config, refusal, timeout, non-`org-aihero` tenant or unparseable body logs `subscriber_count.owned.unavailable` once and renders the existing fallback. Unset, `false` and every other value keep the Kit read and make no drovr call.

The flag stays off until Joel rules on the public wording and rounding: the number moves from Kit's account-wide count, which includes Total TypeScript, to AI Hero's mailable census (about 123k).

## Contract evidence

Read the unauthenticated `https://api.drovr.sh/`, `/llms.txt` and `/openapi.json` catalog documents. No production data or authenticated reads were made.

- `POST /broadcast_status` and `/sharded_broadcast_status` accept exact tenant/broadcast addresses. No list-broadcasts capability is advertised. Reporting must receive explicit references, never infer a send from a content publish.
- `GET /receipts` is a newest-first sample of committed **journey transitions**, capped at 200, with no cursor or broadcast identifier. It cannot reconcile broadcast delivery totals. A returned row count is only a sample size.
- `GET /content/messages` and `/content/publishes` describe content/checks, not sent broadcasts or subscriber totals.
- Kit-style opens, clicks, unsubscribes and attributed revenue have no equivalent in these broadcast status reads. They must be unavailable, not zero or computed from transition samples.

## Operation

`AIH_REPORTING_OFF_KIT_ENABLED=true` switches both newsletter attribution surfaces to the owned response. Unset, `false`, and all other values leave the existing Kit code path and response unchanged. This flag is independent of the sending provider. No deployed flags, environment or production data were changed by this PR.

The owned response is a different, discriminated contract (`provider: "drovr"`), not a Kit-shaped array padded with zeroes. API catalog descriptions and agent instructions explain it. There is no direct email-campaign dashboard panel in the current shared dashboard; the readers are analytics API/agent consumers.

Configuration is server-local JSON, never fetched from Kit:

- `DROVR_API_BASE_URL` and `DROVR_API_KEY_ORG_AIHERO`: existing drovr tenant read credentials. Reporting reuses `parseDrovrSignupDeliveryConfig`: an explicit base URL wins; otherwise the origin of `DROVR_SHADOW_INGEST_URL` supplies the base. Both paths use the same trimmed tenant key, independent of signup flags. Calls time out after five seconds and use `cache: no-store`. Auth errors, network failures, malformed answers and incomplete shard totals return `status: "unavailable"`. Each broadcast and the receipt sample fail independently.
- `AIH_REPORTING_DROVR_BROADCASTS_JSON`: array of at most 50 unique exact references: `{ "broadcastId": "<exact id>", "kind": "single" | "sharded", "sentAt": "<ISO send instant>" }`. The tenant is fixed to AI Hero. An unset or invalid manifest is unavailable, not an empty successful report. A deliberately empty array is an explicitly empty reference set, not evidence of no sends. Only operator-verified send instants belong here; content publication dates do not prove sends.
- `AIH_REPORTING_KIT_HISTORY_JSON`: array of frozen exported report snapshots: `{ "asOf": "<ISO instant>", "range": "24h" | "7d" | "30d" | "90d" | "all", "mode": "standard" | "strict", "productId"?: "<original strict product filter>", "data": <original EmailRevenueOverview> }`. The data contains the original aggregate totals, campaigns and shortlinks, not subscriber rows. The export must have `configured: true`. Validation retains all fields in the existing report contract. Store real exports privately; never commit them to this public repository. A missing, invalid or ambiguous exact-scope snapshot is labelled unavailable. No historical records are deleted, and no live Kit fallback runs with the flag on.

The owner must supply the manifest and privately captured historical exports before enabling. No historical export was captured in this lane, and no live reconciliation is claimed. Large archives should get an owned archive read surface rather than expanding environment configuration indefinitely.

`period` selects manifest entries by their operator-provided send instants, excluding future sends. Row limits and truncation are explicit. Each row's status counters are **lifetime** counters for that broadcast, not events during the query range. They report captured recipients, remaining work, actor-reported sent, skipped, unknown, uncertain and version counts. Single-send identity is checked against snapshot.context; sharded reads must match the exact parent id and tenant and prove every shard readable. Snapshots, approval metadata and contact identifiers are not returned.

`receiptSample` returns only sample size and oldest/newest timestamps from at most 200 latest tenant transitions. It is independent of the query period, has no pagination and cannot prove complete event coverage or reconcile broadcast delivery totals. `engagementAndRevenue` and `productAttribution` are explicitly unavailable. Product filters select historical strict snapshots only; they do not filter current broadcast statuses.

Rollback: unset the new flag or set it to `false`. This restores the unchanged Kit reporting path. It does not change sending or the public subscriber count.
