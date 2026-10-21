# PR2 design review: durable straggler membership (CLOSED — DO NOT BUILD)

**Decision:** drovr `3myfwkqefsocf` / AIH `3myfwnjgs4lwd`: do not build PR2. Drovr expects to migrate the final ~58 waiting v1 actors after its email #3 send and separately introduce an explicit terminal refusal for ~37 final-stop unsubscribed actors. No wire shape is assumed or implemented here. PR1 ships alone after its proof gates; a one-off re-issue requires separate AIH/operator authorization and a privately supplied contact list. No cancellation, migration or re-issue is authorized by this note.

Reopening PR2 requires a separate review, drovr's written approval, PR1 deployed, and real evidence that its joined-membership gap matters. PR1's count-only fingerprint difference is merely a **gap-candidate upper bound** (a subset also differs), not a measured count of genuinely new keys. Never auto-unpark: retain, alert, reviewed operator release. The reviewed original note is retained privately with SHA256 `d82509e793669f9a81a5cbedf053ed170bcc7ca08e26fa92eaacbb73373752e0`; the proposal below is historical, not build authority.

Review requested from `drovr/drovr-desk-2` before implementation. PR1 is owner-only and changes no outbox data or schema. This document is not a migration, implementation, operator action, or permission to replay.

## The PR1 gap this must close

PR1 joins/skips a newly requested starter when that contact has an active or parked owner. It does **not** retain previously unseen keys from that joined request. It does not falsely ACK them, but loss of that particular wake/membership is possible. Reconcile may rediscover a current version; that is not proof that every old key/body will be recovered. Frequency is **unknown**: Whistler's aggregate warning/run counts do not identify new-versus-already-owed membership.

Existing unmarked SDK histories are still legacy, including their no-cap behavior. Neither PR1 nor this note cancels, migrates, or changes them.

## Proposed durable contract

1. Before acknowledging a new producer request or returning a joined/parked result, retain every new owed event in **`AI_DrovrOutbox`**, using its original target, endpoint, tenant/contact/journey, idempotency key, exact body, event clock and ACK/version reference. Await the commit. No `after()`-only capture, best-effort success, or capture-failure-as-join.
2. Reuse the existing first-write dedupe identity. Same key/same body joins; a different body under an existing key is a producer integrity error, **not** an overwrite, new key, refreshed clock, or assumed drovr409. Drovr's receiver is first-write-wins.
3. Lock the per-contact `straggler-owner:` cursor and upsert this membership in one bounded database transaction, in one consistent lock order. No network, broker, logging, or sleep inside it. The current PR1 callback is deliberately synchronous/pure; do not smuggle asynchronous outbox work into it. A separately reviewed transactional port is needed.
4. `held` debt is not retry-ready. Shared replay, ordinary failure capture, cleanup, manual-release paths and sibling scanners must positively exclude the straggler-held family until its reviewed guard admits it. A source-routing convention alone is insufficient. Do not overload `lastError`, `releasedAt`, body, wire key, or occurrence time as authority.
5. Durable continuation metadata must distinguish this family, bind owner generation, original startedAt/deadline, exact key/body membership and the original ACK/version reference. The representation is **open for review**: existing main `held` rows do not contain all this authority. An additive discriminated `heldContinuation` representation is a possibility, not an approved DDL change. It must remain disjoint from any native/N7 frozen-roster schema and pass strict bounded validation.
6. New membership joins the current generation without resetting its original seven-calendar-day clock. Continuations claim the generation and next attempt/wake with CAS. A parked generation remains parked: discovering new debt must not unpark it, refresh its clock, or silently create another generation. Decide an explicit operator repair/new-generation contract before release code.
7. Build a fresh, narrowly defined admission guard for the non-native straggler-held family. Native-positive lanes are excluded and keep their separate contracts. Read fresh locked target/current flags and DB UTC where required, then end the transaction before HTTP. Cached SDK steps are not fresh permission; this is not a continuous-lock or exactly-once claim.
8. Separate HTTP acceptance, rejected/deferred outcomes, native marked non-HTTP failures, capture failure and ACK/settlement. A drovr2xx is not authority for a native ACK. Native marked provenance stays in-process and cannot be reconstructed from serialized fields or ALS context. Native expired ACK evidence remains terminal, with no retry/recapture/clock refresh; independently owed debt stays independently owed.
9. Completion may settle only the exact admitted membership and matching original ACK scope. New keys arriving after that snapshot remain owed. A crash after HTTP but before commit resends only original key/body/clock under the receiver's first-write-wins contract; never recapture a newly computed body.
10. Keep target/environment boundaries, immutable source clocks, retained metadata and parked debt across rollback. Flags and operator release must fail closed. No automatic cleanup of parked/held debt as if delivered, and no general replay escape hatch.

## Evidence required before a PR2 release

- No-SQL model tests: capture-before-join, failed capture refuses success/ACK, concurrent joined-key union, same-key/different-body refusal, immutable clocks/refs, stale generation, old histories, seven calendar days, parked new-key joins, source-off wakes and rollback.
- Approved SQL fixture proof: one owner, all independently owed membership retained under contention, transaction rollback and lock order, completion-versus-new-key race; no HTTP in a transaction.
- Scanner/cleanup/operator inventory proving positive exclusion on every alternate path. Mutation tests must show those exclusions and fresh guards matter.
- Exact-head SDK/handler tests for cached-step retries, durable write-before-acknowledgment and event-ID namespace separation. No blanket native/N7 compatibility claim from ordinary straggler tests.
- Separate live/operator approval, default-off rollout where appropriate, rollback and count-only proof. No production cancellation as code behavior.

## Review questions for drovr

1. Approve the durable capture-before-join and immutable first-write conflict rules?
2. Which bounded metadata representation safely distinguishes straggler-held authority from ordinary held rows and native/N7 continuation authority? Recommendation: an explicit validated discriminator, not overloaded columns.
3. Which native-positive lanes and replay/manual-release/cleanup readers must be excluded? Please identify receiver-side final-stop distinctions; `event-not-live` alone does not identify an unsubscribed final stop.
4. What explicit operator repair/new-generation policy is acceptable for genuinely new debt arriving after a permanent park? Recommendation: retain, alert, and require explicit reviewed release; never auto-unpark.

No PR2 code has been written. Implementation waits for drovr review and AIH's separate authorization.
