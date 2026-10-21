# Read-only legacy straggler inventory

**Read-only operator procedure, not an executed production inventory.** No cancellation, replay, re-issue, deployment, POST or automatic operation is included. Run only with explicit production read authority and verified upstream migration/refusal status. An evidenced final-stop cohort still needs separate approval for any targeted cancellation.

New ownership does not rewrite old queued histories. Existing legacy chains can keep running; neither a zero parked-alert count nor fewer warnings proves they stopped. Warning samples are not active-run or chain inventories.

## Read source and coverage contract

Use the production Inngest control plane, not Axiom warnings. An existing read-only discovery path is:

```text
GET https://api.inngest.com/v2/apps/ai-hero/functions?limit=100
GET https://api.inngest.com/v2/apps/{positively-discovered-app-id}/functions/{positively-discovered-function-id}/runs
```

These are query shapes, **not a claim that the provider currently supports an all-history window**. Previous probes encountered unsupported filter combinations/default-window ambiguity. Validate the currently documented API/export and response schema before relying on it; no silent fallback to defaults, a first page, or a recent window. Use an existing approved read-only CLI/export when necessary. Do not add production credentials to app code or put a signing key in argv/logs.

1. Positively match the production app, function slug `ai-hero-drovr-contact-sync-retry-v1` (or its unprefixed registered slug), trigger `drovr/contact-sync.retry-requested`, environment and archive state. Refuse ambiguous identity.
2. Fully paginate all active statuses, including queued/scheduled, running and paused/sleeping as represented by the verified provider schema. Keep unknown statuses in a separate unresolved count; never call them terminal. Follow nonrepeating cursors until explicit `hasMore=false` and verify the covered time range includes the oldest active histories. Missing pagination/coverage metadata is **blocked**, not zero.
3. Read each active run's original triggering event and necessary parent/continuation history through approved read-only detail/export facilities. Inspect the original event, not a reconstructed current contact. `data.stragglerOwner` **absent** means legacy. A present malformed marker is unknown, not legacy. Protocol1 marked runs are the new owner population and must be counted separately.
4. Build a normalized stream in memory. Do not save raw events, request bodies, emails, event/run IDs or contact IDs to inventory artifacts. Provider IDs may be used transiently for pagination/lineage/deduplication; published output is counts only (contactId hashes are the only permitted identity if a private follow-up requires one).
5. Extract distinct refusal codes from each legacy run's original `data.items[].reason`; deduplicate repeated codes within a chain. Missing items/reasons is `unknown`, never silently `event-not-live`. A chain with multiple codes appears in multiple code groups, so code counts need not sum to the total.
6. A run count is not automatically a chain count: a running parent can overlap its already scheduled continuation. Collapse only **verified** parent/child history into one active head/root. If lineage is unavailable, publish `unclassifiedActiveRuns` and leave `verifiedChains`/chain age unknown for those runs. Never manufacture a chain identity from contactId or `(contactId, attempt)`.
7. Chain age needs a positively reconstructed original retry clock (e.g. the original attempt1 `now` step with verified lineage); otherwise mark it unknown. Also report current-run age from verified queued time, separately. Never infer chain age from `attempt*2h`, daily spacing, or an event's possibly backdated `occurredAt`.
8. Refuse an authoritative/complete result on failed pages, truncated histories, missing event data, unknown statuses, ambiguous lineage or unverified time coverage. A partial diagnostic may still show counts, prominently labelled partial, with unresolved counts; it is not cancellation authority or a legacy-retirement zero proof.

## Documented aggregate query

The following is an analytical query over a **validated in-memory/export-normalized view**, not a production database query. `rootChainHash` is non-null only for verified lineage; `firstRetryClock` is non-null only when reconstructed. The collector supplies the single UTC `inventoryAt` and validated production/coverage booleans. Raw payload/IDs are not output.

```sql
-- DuckDB-style SQL over the normalized read-only stream.
WITH active_legacy AS (
  SELECT * FROM normalized_inngest_inventory
  WHERE productionVerified AND coverageVerified
    AND statusClass = 'active'
    AND NOT protocolMarkerPresent
), chain_codes AS (
  SELECT DISTINCT rootChainHash, contactIdHash, firstRetryClock,
         unnest(refusalCodes) AS refusalCode
  FROM active_legacy
  WHERE lineageVerified AND rootChainHash IS NOT NULL
), grouped AS (
  SELECT refusalCode,
    CASE
      WHEN firstRetryClock IS NULL THEN 'unknown'
      WHEN inventoryAt - firstRetryClock < INTERVAL '1 day' THEN '<1d'
      WHEN inventoryAt - firstRetryClock < INTERVAL '7 days' THEN '1d-<7d'
      ELSE '>=7d'
    END AS chainAge,
    rootChainHash, contactIdHash
  FROM chain_codes CROSS JOIN inventory_snapshot
)
SELECT refusalCode, chainAge,
       count(DISTINCT rootChainHash) AS verifiedChains,
       count(DISTINCT contactIdHash) AS distinctContactHashes
FROM grouped
GROUP BY refusalCode, chainAge
ORDER BY refusalCode, chainAge;
```

Publish alongside it: snapshot UTC, verified app/function/environment, page/history counts, declared time coverage, active marked/legacy/unknown-protocol run counts, unclassified active runs, unknown-status count, unknown-chain-clock count, and current-run age buckets. Do not output provider IDs or emails. The query's `coverageVerified` predicate is not a substitute for refusing an incomplete collection.

**Final stop is not inferred:** `event-not-live` alone does not identify an unsubscribed final-stop cohort. Require a validated upstream terminal refusal shape and separately authorized cohort evidence before classifying it. Do not re-drive final stops. Any one-off re-issue for migrated contacts is a separate operator decision, not a side effect of this inventory.

## New owner liveness and recovery

Keep marked owner population counts separate from the legacy run inventory. Under separately approved read-only owner access, flag `active` rows already past their JSON deadline, including rows with no known active continuation; absence of warnings is not a liveness proof. A subsequent starter or continuation parks an expired active owner with `owner-expired`. Use the original JSON clock/deadline and attempt, never the shared cursor `updatedAt`, for age. Malformed/unknown rows remain unresolved.

Include `parkedOwners > 0` joins in the operational digest: unrelated future keys can be blocked by a permanent park. Recovery is not automatic. Follow the [exact-generation, operator-gated recovery procedure](./drovr-straggler-owner-proof.md#operator-gated-recovery-from-a-park); that CAS completes the parked owner without an ACK or send, and does not authorize replay or cancellation.

## New-protocol gap-candidate telemetry (not this inventory)

`aih.drovr_sync.joined_membership_candidate` has numeric counts only: `starters`, `incomingKeys`, `unchangedMembership`, `changedMembershipCandidate`, `unknownMembership`, `parkedOwners`. It compares the joined set's sorted-key fingerprint with the owner's **original** set, without retaining a roster or logging any ID.

- Same fingerprint: no new membership under the normal SHA256 assumption.
- Different: **upper-bound gap candidate**, not a measured new-key count; a subset also differs.
- Unknown: no retained fingerprint; not evidence of no gap.

Aggregate sums, with explicit collection interval and log-coverage caveats. Zero candidates is useful only with adequate coverage and zero unknowns; nonzero requires a separate exact-classification review, not an automatic PR2 build. No held-debt/roster implementation is planned; reopening requires separate evidence and review.
