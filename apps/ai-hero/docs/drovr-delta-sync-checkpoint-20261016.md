# Drovr delta sync — 2026-10-16 checkpoint

**Draft PR #428; not merge/deploy/enable ready.** This is a source-preservation checkpoint, not completion of the round-2 review. No production SQL, HTTP, stored flag changes, PR merge or deploy was performed.

## Preserved history

- Foundation: `67fe89165b6d14dba127d3599dc7d7a4a435d4b5`.
- Separate test-only broker-leak fix: `cd9c0b036bc692bc5c0f5d76609b8579de2cb02d`; global setup unchanged.
- Explicit main merge (not rebase): **`ac0fcffeadd306432a11a62204e2d3c2cb0fd344`**, merging `09977e8f0ead5d478e81d737926ade4843f16061`.

## Rollout boundary

The one app/admin flag is `drovr-profile-ack-enabled`, default OFF in production, preview, development and test. Fresh bounded Redis reads fail OFF; no environment-variable alternative exists. New registration, completion and failed/partial-request tombstones belong behind this same gate. Genuine signup, purchase and unsubscribe remain independent.

OFF intentionally preserves main's legacy optimistic producer ACK, including non-receiver-proved timestamp semantics, rather than trigger additional unchanged-version sends. This is a rollout trade-off, not the new proof protocol. The executable pinned-main oracle checks every identical-fixture prefix: current 9 producer submissions plus 4 conservative downstream repair candidates versus main 60; repeated capture candidates 2 versus 48. This is a local model, not deployed POST measurement or complete in-flight transition proof.

Known new metadata is a **one-way reader boundary**. Native purge cannot silently discard an incomplete original request while its writer gate is OFF/unknown. It returns Schema-typed `PurgeRefused`, reason `profile-ack-protection-flag-off`, with zero whole-tick deletions, no new tombstone and no per-reference ACK pin. Next scheduled tick re-evaluates; no hot loop.

Named structured error signal: **`drovr.outbox.purge_refused`**, emitted once per refused tick with only protected/candidate counts and a literal prompt, never ids. Drovr/Shaman should alert when it persists more than 24 hours; no pager routing guarantee is claimed. Recovery is approved restore/re-enable or explicit save/cancel/real-native-proof drain, never JSON trimming, fake delivery or clock refresh. See [the outbox runbook](drovr-outbox-runbook.md).

## Implemented/tested foundations

- Fifth independently versioned `profileAck` member in the existing bounded control column, not nested in `replayProof`; no additional DDL.
- Frozen original profile/link scope, first bodies, sources and clocks; delta/month identities; immutable first complete proof. `confirmationClock` alone drives age from the original delivered profile's `occurredAt`; `provedAt` is audit only.
- Dedicated fixed-sentinel `ackTombstone` control status/source/endpoint, positive native query/update allow-lists, and literal refusal before capture/transport/broker ports can treat control data as wire data.
- Atomic native-settlement/first-proof helper: native settlement, exact proof, forward-only version-store ACK, completion and prior failed-marker removal commit or roll back together. Normal success adds no row. Completion ends member pointers; original whole membership/proof remains on its coordinator until ordinary retention.
- ON purge writes/fences the failed/partial-request tombstone before deleting any necessary delivered evidence in the same transaction. Bounded 128-row chunks under the existing 500-candidate tick budget. Duplicate bookkeeping preserves first cause, proof and expiry; an evidence-expired fence cannot be revived.
- Full re-sync/backfill remains **dungeoned, not repaired**; even dry-run requires the exact Joel override, none configured.
- Other round-2 pacing/ownership/queue/held/stop/supersession/reconciliation changes are preserved here; final PR-wide runtime/operator/retention review remains required.

## Validation at this source checkpoint

All evidence below was run on the local post-main source tree before this checkpoint commit, not remote exact-head CI:

| Check                                                            | Result                                                                                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded broad producer/library/function/CLI suite                | 3,061 passed; 200 passing files; 450 guarded skips                                                                                                             |
| Separately authorized disposable MySQL, current workflow groups  | **560 passed / 30 suites / zero skips** (554 + ordered activation group 6)                                                                                     |
| Current complete SQL log pattern audit                           | No configured queue-failure/401/HTTP/outbound-host hits; log SHA256 `8bcf349a54c2cb1cfc505e4cb95c17bde1a0f91a476428ba04084f0ff40b5073`                         |
| Purge/control focused suite                                      | 188 passed / 4 files, including 37 actual MySQL tests                                                                                                          |
| Six typed parser/clock/dungeon mutations                         | Assertion-killed, restored, baselines green                                                                                                                    |
| Two native due/update allow-list mutations                       | Assertion-killed by actual SQL test, restored, baselines green                                                                                                 |
| Two new purge ordering/OFF-gate mutations                        | Assertion-killed, byte-exact restored; full SQL/broad baseline green                                                                                           |
| Classic TypeScript                                               | Exit 2: three pre-existing entitlements TS2345 diagnostics and main-inherited `purchase-fields-write-fence.test.ts:81` TS7023; **no touched-file diagnostics** |
| Frozen install / workspace prerequisite builds / diff whitespace | Passed                                                                                                                                                         |

The clean-log audit is **not a whole-network-isolation guarantee**. Synthetic fixtures only; the disposable MySQL service remains desk-owned. Remote exact-head CI/build/MySQL/pricing/security readback is still required.

## Next work, in desk-approved order

1. Worker wiring, including terminal expired evidence with no ACK retry/HTTP/history reconstruction and retained native debt still owed.
2. Immutable capture/registration before publication and frozen refs through SDK workers/shards/retries/continuations. Known registered requests must not fall through OFF's legacy clock refresh during a transient flag failure.
3. Dedicated first-created +400-day / positive-version-change tombstone purge, including late duplicate/lifetime proof.
4. Remaining N7 parent/family/owner-birth lifecycle, N13 actual current-offer receipts/retention, worst-case SDK/fetch pacing runtime and operator execution proof.
5. Refreshed prose/five-member/read/retention/nits audits, final exact-head validation and approval/dependency warnings.

The atomic helper is not yet connected as the complete automatic producer/worker lifecycle. The receiver's v4 train/migration dependency is not a live guarantee. Keep the PR draft and flag OFF. The single completion packet is reserved for actual completion. Deadline: 2026-10-22 16:00Z; escalate expected work past 2026-10-20 12:00Z early with the safely shippable subset.
