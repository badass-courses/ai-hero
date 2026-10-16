# Dedicated profile ACK marker lifetime checkpoint — 2026-10-16

Draft PR #428 remains unfinished and must remain draft. `drovr-profile-ack-enabled` remains OFF. This is a code/test checkpoint, not deploy, enable, merge or production verification authority.

## Dedicated control expiry

`expireAckTombstones` is a separate control-only sweep, composed after a native delivered-receipt purge tick **only when that entire tick was not refused**. Native `purged` counts and optional `ackTombstonesPurged` counts are separate. Controls never become delivered receipts, POST candidates, pins or failure counters.

A fresh bounded fail-closed flag read precedes SQL and is repeated before the transaction. OFF/error performs no expiry transaction. Database UTC or a positively locked, different current profile version authorizes expiry. Missing version evidence is not a version change. Lifetime is exactly the original marker creation plus 400 days; neither duplicate marker nor delayed retry renews it.

The candidate page is bounded at 500 and excludes young unchanged markers before applying its limit. Contact/version locks precede marker locks. A locking, bounded native-key lookup avoids repeatable-read snapshot omissions; every native control read/write/verification is chunked to at most 128 rows, with at most 1,024 native references. No schema change, new control member, side table, ID allocation, runtime SET, HTTP or broker call is needed.

## Why surviving native pointers need a negative retirement fence

Deleting a marker while native debt survives must not let a later native receipt purge create another 400-day marker. In the same transaction, expiry retains the original `createdAt`/`expiresAt` and a negative retirement reason inside the existing `profileAck` member on **all surviving matching original native pointers**, verifies every write, then deletes the exact dedicated marker. Other four envelope members, native bodies, status, attempts, source, first clocks, prose and ordinary debt are unchanged. Missing original evidence remains terminal `AckEvidenceExpired`; retirement is not positive ACK proof and cannot coexist with coordinator completion.

Ordinary receipt retention can subsequently remove retired pointers without recreating a marker. No ACK pins are introduced. When all native pointers are already absent, marker deletion does not make absence into never-registration: original SDK registration epochs older than 400 days and unchanged versions without fresh provenance still refuse capture, including OFF. This is a one-way reader boundary: code predating the retirement reader is not an authorized rollback after those bytes exist. Keep new readers installed; do not enable the flag or purge metadata as a rollback technique.

## Evidence at this checkpoint

- 68 focused live MySQL tests, including exact 400-day minus-one-millisecond boundary, positive version versus missing version, no-survivor ancient SDK resurrection refusal, native-debt preservation, later-purge no-renewal, two concurrent sweeps, rollback before/after actual DELETE, and missing-column failure on the 129th-member verification chunk.
- 500 young markers do not starve a later positive-version candidate.
- Property coverage checks age/version boundaries and preservation of all four independent control members; conflicting negative lifetime refuses renewal.
- Five mutants killed and restored: omitted surviving fences, renewed marker from later native purge, bypassed whole flag, bypassed age/version authority, and first-lifetime replacement.
- Full 30-file MySQL workflow: **591 passes, zero skips** (585 plus six activation tests), including prerequisite schema package build. Initial run encountered the already separately reproduced main checkout MerchantCharge deadlock; its failed log is retained, then the complete unmodified workflow passed. No checkout change or test exclusion.
- Exact relevant CI unit selection: **3,419 passes / 235 files**, with 502 explicitly guarded SQL tests skipped across 23 files; those guards are not the SQL proof above.
- Classic typecheck still reports the same four untouched entitlement/purchase-field baseline errors, with no touched-file errors. Exact-head remote CI is required again after push.
- An additional unrestricted repo-wide unit invocation was **not green**: route flag-adapter mock initialization, discovery operation-count expectation, and missing Cloudinary fixture configuration failed outside this selection. This checkpoint does not claim full-repo unit green or establish the ancestry of those failures.
- SQL log pattern audit found no configured hits. This audit is not whole-network isolation.

## Still open

N7 native-family/parent-child healthy gates, N13 offer/retention/selection fairness, worst-case actual SDK/fetch timing, operator history/concurrency/deploy-order, final audits, and exact-head checks. No production HTTP/SQL, stored flag mutation, deploy, merge, final packet or fixture teardown occurred.
