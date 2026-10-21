# New straggler owner: proof and rollout boundaries

## Limits first

- **Unmarked legacy histories stay legacy, untouched and uncancelled.** This prevents new-protocol multiplication; it does not promise an immediate reduction in existing retry traffic. Initial producer/bulk POSTs are not deduped by this owner.
- PR1 can skip genuinely new keys in a joined/parked starter without durably retaining that new membership. It does not falsely ACK them. Exact frequency and complete reconcile recovery are unknown.
- `joined_membership_candidate` is an **upper-bound candidate**: an unequal key-set fingerprint can be a subset, not new keys. No roster or outbox changes are included.
- **PR2 is not planned**, following drovr's review. Reopening requires separate evidence/review/authority; no auto-unpark or release implementation is included.
- No migration, cancellation, one-off re-issue, merge, deploy or live enable occurs from this PR.

## Protocol

Only new starter call sites add protocol1 and split retries per contact. `straggler-owner:` plus SHA256(contactId) reserves an existing `AI_ContactSyncCursor` row; bounded JSON carries generation, state, original startedAt, seven-day deadline, next attempt and an optional original-key-set fingerprint. No DDL.

One transaction acquires the owner row's X lock via no-op duplicate update, locks/validates it, uses DBUTC, and CAS-writes the next claim. Daily starters join without refreshing the original clock. Continuations use generation+attempt event IDs in a namespace separate from old digest/attempt IDs; the final wake is no later than the original deadline. This is not digest-only dedupe over a24h window and not a short singleton claiming the2h gaps.

Actual deliver/birth/redeliver SDK callbacks re-read active generation/attempt/deadline before delegating, because the outer claim can be memoized. A denial is retained as serializable data, not an Error identity lost across SDK replay. Cached success is an already retained result, never fresh POST permission. The transaction ends before delegation: no continuous-lock, exactly-once or native/N7 ACK-authority claim.

Park is permanent. Joined starters cannot unpark or silently replace that generation. Completion changes only the matching active owner. Original wire keys, body/payload, occurredAt and ACK/version scope are passed through unchanged. Marked malformed protocol/address-as-contact inputs fail closed; genuinely absent markers take the unchanged legacy path and steps.

## Local no-SQL checks

149 tests passed, zero failures/skips:

| File | Cases |
|---|---:|
| `contact-sync-straggler-owner.test.ts` |25|
| `contact-sync-straggler-owner-mysql.test.ts` (ports/model only) |10|
| `contact-sync-straggler-retry.test.ts` |16|
| `drovr-contact-profile-sync.test.ts` |19|
| `drovr-events-deliver.test.ts` |79|

The no-SQL run used synthetic fixtures, stubbed ports and a network guard. The native project typecheck also passed after building the two required local workspace packages. No production/payment test or source flag change occurred. These are targeted unit/model checks, not an all-repository suite or native/N7 lifecycle proof.

## Full CI-filter follow-up

CI exposed a missed handler-level expectation in `src/inngest/functions/drovr-contact-profile-sync.test.ts`: new starter fan-out is intentionally an event **array**, even for one contact, while the test still expected the old starter object. The test now checks the one-element array, protocol marker, unchanged items and original ACK scope. A separate explicit assertion confirms an **unmarked legacy continuation remains exactly one old event object**, with its original ID/body/clock and no marker. No production behavior changed in this follow-up.

The **entire** CI `drovr, subscriber-marketing and evergreen unit suites` command was then run locally through `muster-heavy`, using all nine CI path filters and `--maxWorkers=4` (`--minWorkers=1`). Result: **3,013 passed, 435 guarded MySQL cases skipped, zero failed**, across 197 passed / 25 skipped files in 28.58s. No SQL URL or fixture load was supplied. Counts are verified from individual assertion statuses and the console summary: this Vitest version's top-level JSON counters misleadingly count skipped cases as passed. This replaces the earlier targeted-only coverage as the current unit-suite evidence. Hosted exact-head CI still must be checked separately.

The closed PR2 proposal has been removed from the PR and retained only in lane evidence; no PR2 implementation is planned.

## Approved isolated MySQL proof

One freshly authorized process on the retained local fixture, maximum2 connections, **55ms** measured harness duration, peak2 observed sockets, zero non-fixture network. Three new synthetic keys only, explicit approved schema, no DDL/import/HTTP/service/container/config changes. The older retained synthetic leftover was not read/matched/deleted.

| Phase | Result |
|---|---|
| A: original bootstrap, controlled duplicate-lock rendezvous <=250ms | Two duplicate starters; exactly one real `ER_LOCK_DEADLOCK`, errno1213, SQLState40001: `Deadlock found when trying to get lock; try restarting transaction`. |
| B: proposed bootstrap,20 simultaneous starters | Exactly1 claim,19 joins. |
| B:20 simultaneous same-generation continuations | Exactly1 claim,19 joins; generation/original clock/deadline unchanged. |
| C: callback failure and >500-character cursor | Both bootstrap writes rolled back; no retained row before seeding the clock case. |
| C: synthetic original clock already seven days old | Parked on the original deadline; later starter did not auto-unpark. |
| Cleanup | All3 new keys removed only against recorded exact cursor+generation; verified zero remain. Primary SQL error and cleanup errors retained separately; no cleanup errors. |

The original `INSERT IGNORE` duplicate-record shared locks can mutually block their `FOR UPDATE` upgrades. The no-op `ON DUPLICATE KEY UPDATE name=name` obtains a duplicate-primary-key X lock directly. See Oracle's [documented InnoDB duplicate-record lock behavior](https://docs.oracle.com/cd/E17952_01/mysql-8.0-en/innodb-locks-set.html). Unit tests retain the old lock-cycle negative control.

**Historical failure is not hidden:** the earlier attempt's partial-batch cleanup assertion masked its original SQL error and left one synthetic key. The desk ordered it left in the throwaway fixture until separately owned container/volume removal by2026-10-26 12:00Z. Its exact key/schema and the failed raw evidence remain in the private handoff. The successful A counterexample captures a real old-adapter hazard; it does not retroactively recover that earlier lost error or classify unrelated original N7 findings. There was no unapproved SQL retry or force-delete.

The approved SQL harness/scope/source hashes/raw code/message/snapshots and results are retained privately under the isolated clone's `.git/straggler-*` evidence. It is a real SQL concurrency check for this adapter, not production performance, actual SDK scheduler causality, full native authority or a live receipt.

## Telemetry contract

Use AIH's existing structured logger/Vercel-to-Axiom pipeline and dataset, with cleared ambient context. No application credentials or new transport is added. The normal logger envelope (`event`, `_time`, `level`, empty context) is infrastructure; the parked event has **exactly these seven business fields**:

```text
event: aih.drovr_sync.parked
alertId: straggler-parked:<immutable generation UUID>
contactId: original opaque contact ID, never an address
refusalCode: sorted distinct refusal codes, comma-joined when mixed
eventTypes: sorted distinct event types
attempts: logical claims made in this chain, not HTTP calls or elapsed age
firstAttemptAt: original starter clock, ISO UTC
parkedAt: original park decision DBUTC, ISO UTC
```

No email, body, payload, key roster or extra business fields. Alert ID stays stable across retries. The SDK alert step suppresses repeated successful calls; a transport/handler ambiguity can still duplicate logs, so downstream deduplication uses `alertId`, not an exactly-once claim.

`drovr/alert-boss` owns the pickup rule: hourly digest, page only for a non-`event-not-live` refusal or >10 distinct parks/day. **The event is not live merely because this PR exists.** After separate operator deployment, confirm a genuine park in the existing dataset and notify drovr that the event is live before claiming pickup is configured.

The separate `aih.drovr_sync.joined_membership_candidate` log has numeric counts only: starters, incomingKeys, unchangedMembership, changedMembershipCandidate, unknownMembership, parkedOwners. It contains no IDs or payload. See the [read-only inventory/aggregation runbook](./drovr-straggler-owner-inventory.md).

## Expected cohorts and conditional arithmetic

Drovr reports ~58 email #3 v1 contacts migrating after its send ends (~16:30–16:45PDT), with events comfortably within7days. They should fold after migration rather than park. ~37 unsubscribed v1 actors are final stops and need no re-drive: if still deferred in the new protocol they correctly park; drovr separately plans an explicit terminal refusal so they can terminate earlier. That future wire shape is not guessed or implemented here. These are drovr's expectations, not a measured outcome; old unmarked chains remain outside this cap.

Whistler reported92 distinct contact-attempt pairs across59 contacts in a2h warning sample. If all that sampled stuck-chain component were under one-owner semantics, the simple illustration is92−59=33 fewer chain-equivalent attempts,33/92≈35.9%. This is not a measured drop, endpoint-call count, whole-function forecast or independent proof of scheduler cause. Preserved legacy chains and other traffic make the immediate actual reduction **unknown**.

## Deployment and rollback handoff

No new flag, migration or deployment is performed. Existing source-off behavior retains its no-HTTP continuation; owned wakes still preserve age and park at the original deadline. Native/N7 writer/ACK and all unrelated holds remain unchanged.

Deploy only with operator approval after review/CI. A safe protocol rollback must retain the dual-reader handler for already queued protocol1 histories while reverting new starter production; a wholesale revert to a handler that ignores the marker would lose the ownership/cap semantics for those histories. Keep cursor rows; do not auto-unpark/delete them or cancel runs as a rollback shortcut. Inventory first; any targeted cancellation/re-issue is a separate bulk-operation approval.
