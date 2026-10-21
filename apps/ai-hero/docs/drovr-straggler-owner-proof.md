# Straggler ownership protocol and recovery

## Scope and limitations

- Only newly marked starters use ownership. Unmarked queued histories retain the legacy steps, event shapes and uncapped behavior. Nothing automatically migrates or cancels them, and an immediate traffic reduction is not promised.
- Initial producer/bulk sends are not deduplicated by the retry owner. Joined or parked starters may contain new keys that are not durably retained. They are not falsely acknowledged, but complete recovery of those keys is not guaranteed.
- The membership fingerprint is an upper-bound gap signal, not a roster or an exact new-key count. No held-debt implementation, schema change or outbox change is included.
- A park is permanent unless an operator explicitly approves the recovery procedure below. Completion or recovery never implies that the receiver accepted the original profile version.

## Owner protocol

`straggler-owner:` plus SHA256(contactId) is an **80-character ASCII key**, independent of contact ID length, in the existing `AI_ContactSyncCursor` table. The adapter rejects names longer than 255 characters and names outside that exact namespace before acquiring a connection. The JSON cursor is bounded by the existing 500-character column and holds generation, state, original clock, seven-day deadline, next attempt and an optional original-membership fingerprint.

A transaction obtains the primary-key X lock through `INSERT ... ON DUPLICATE KEY UPDATE name = name`, reads the cursor and DB UTC under `FOR UPDATE`, validates it, then compare-and-swaps the cursor. Transactions end before any delivery, birth, logging or broker call. `updatedAt` deliberately remains unchanged: owner liveness is defined by the JSON clock/deadline/attempt, not the shared cursor bookkeeping timestamp. A joined starter does not issue a cursor update.

A new generation normalizes an app clock ahead of DB UTC by **at most five minutes** back to DB UTC. The normalized start and `start + seven calendar days` deadline are then immutable. Larger future skew creates a parked quarantine, emits `owner-clock-skew`, and only then fails non-retriably. It never sends or acknowledges events. Quarantine uses the first DB UTC observation because the supplied future clock is untrusted. Joining an existing owner never changes its original clock.

Both starters and continuations check an active owner's deadline before joining or claiming. A starter that encounters an expired active owner parks it even if the previous chain died without leaving a continuation. It emits `owner-expired`, using the persisted original clock and attempt count, not the new starter's clock or membership. There is no background reaper: an otherwise orphaned row surfaces when a fresh starter or continuation encounters it; read-only inventory should also flag overdue active rows.

Only a `rescheduled` receipt leaves ownership active. Every terminal receipt completes the matching active generation. In the current legacy union, the only other status is `delivered`; an unsubscribed hold is represented by zero accepts and rejected items, so it terminates without an ACK. Unhandled exceptions leave the owner active for expiry detection rather than pretending the delivery succeeded.

Actual delivery, birth and redelivery callbacks re-read the active generation, attempt and deadline. A memoized outer claim is not fresh POST permission. Denials are saved as serializable data so SDK replay cannot erase their park/alert meaning. This is not continuous-lock or exactly-once delivery.

The wrapper rewrites only the two existing `reschedule` sends whose event name is `drovr/contact-sync.retry-requested`. It validates an integer timestamp and the next attempt, preserves body/keys/occurrence clocks/ACK scope, adds generation ownership, and clamps the wake to the deadline. Other step IDs, event names and arrays pass through unchanged; a missing/invalid continuation timestamp fails closed, never becoming `NaN`.

Dedupe namespaces are disjoint: legacy IDs start with `contact-sync-retry:`, starters with `contact-sync-starter:`, and owned continuations with `contact-sync-owned:`. Full-string equality cannot collide across these prefixes. Owned IDs contain the immutable generation and next attempt rather than relying on a digest repeated inside the provider's dedupe window.

## Fan-out tradeoff

This is a source bound, **not an observed batch-size distribution or savings forecast**. The standard backfill producer defaults to 50 source rows per page and emits messages of at most 100 events. The bulk consumer combines at most 100 messages. That path can therefore carry up to 5,000 distinct source contacts and 10,000 events in one bulk run. These are bounds derived from current producers, not a new receiver-enforced validation limit for manual or future payloads.

For N deferred contacts and S deferred events, starters number at most `min(2N, S)`: the bulk handler separately groups event-not-live and cold-start refusals, so a contact present in both groups can have two starters. With one refusal category per contact, it is N starters, compared with up to two aggregate legacy retry runs for the whole bulk deferral. Only one generation claims ownership; other starters join. Successful retry delivery is per contact rather than batched across contacts, so large new backfills can increase Inngest runs and POSTs. Birth/redelivery and transport retries can add more calls. Profile-sync deferrals involve one contact. No production distribution or immediate net reduction has been measured.

## Telemetry

Use the existing structured logger/Axiom pipeline with ambient log context cleared. The infrastructure envelope is separate; `aih.drovr_sync.parked` has exactly seven business fields:

| Field | Meaning |
|---|---|
| `alertId` | Stable `straggler-parked:<generation>` identifier. |
| `contactId` | Opaque contact ID, never an address. |
| `refusalCode` | Sorted comma-joined receiver refusal codes, or local `owner-expired` / `owner-clock-skew`. Local codes are not receiver wire verdicts. |
| `eventTypes` | Sorted distinct types available to this decision. Empty means unknown original types for an orphan: a joining starter is not original provenance. |
| `attempts` | Logical claims in this generation, not HTTP calls or elapsed age. Clock-skew quarantine has zero claims. |
| `firstAttemptAt` | Immutable validated/normalized original start, ISO UTC. |
| `parkedAt` | Original park decision DB UTC, ISO UTC. |

No email, payload, body or key roster is logged. Alert IDs remain stable across alert retries; downstream deduplication must use `alertId`. Ambiguous logging can duplicate entries, so this is not an exactly-once alert guarantee.

The operational policy is an hourly digest, with escalation for a non-`event-not-live` refusal or more than ten distinct parks per day. Both local failure codes qualify for the former. Include parked-owner join counts in review so later unrelated deferrals do not disappear behind an old park. Deployment and genuine dataset verification must precede any claim that alert pickup is live.

`aih.drovr_sync.joined_membership_candidate` contains counts only: `starters`, `incomingKeys`, `unchangedMembership`, `changedMembershipCandidate`, `unknownMembership`, `parkedOwners`. Unequal fingerprints can represent a subset, so they are only gap-candidate upper bounds. See the [read-only inventory runbook](./drovr-straggler-owner-inventory.md).

## Operator-gated recovery from a park

No automatic unpark, deletion, replay or recovery API is provided. A permanent park also blocks unrelated future starters for that contact, so recovery must be an explicit operational decision:

1. Obtain recorded operator approval for one exact contact/owner generation. Confirm the receiver's migration/refusal issue or app clock fault is resolved. Inspect the original run, park alert and count-only gap evidence; unresolved debt is not proof of acceptance.
2. Using an approved database client on one connection, lock the exact owner row in a transaction and read its complete cursor. Verify the expected key, generation and `state = parked`. Abort if missing, changed, malformed, active or already complete. Do not use `updatedAt` as the owner's clock.
3. Serialize the same owner with **only `state` changed to `complete`**. Preserve generation, original clock/deadline, attempt and fingerprint; validate the resulting JSON is at most 500 characters. Execute a parameterized cursor update requiring the exact key **and exact previously read cursor**, preserving shared cursor bookkeeping. Require exactly one affected row; otherwise roll back. Commit before any external action.
4. Record the approval and exact CAS outcome in the private operational audit. This changes no ACK/version state and sends nothing. It merely allows a subsequently authorized fresh deferral to establish a new UUID generation; old queued continuations cannot act for that new generation.
5. Decide separately whether any missing original/joined keys need recovery. Any cancellation or re-issue needs its own reviewed source, scope and approval. Never synthesize an accepted ACK, reuse a parked generation or replay a broad cohort as part of unpark.

## Schema and validation scope

An operator-provided read-only production DDL readback confirms `name varchar(255) NOT NULL` primary key, `cursor varchar(500) NOT NULL`, nullable `watermark` and `heartbeatAt` timestamps with millisecond precision, and `updatedAt timestamp(3) NOT NULL` with a default and `ON UPDATE`. The table uses InnoDB and `utf8mb4_unicode_ci`. Bootstrap supplies all required non-default values. Local fixture column/collation parity is **unverified**; no PlanetScale/vtgate write smoke is claimed.

The unchanged bootstrap/locked-read/CAS SQL has an isolated real-MySQL concurrency proof, including one-claim contention and the old shared-lock-upgrade negative control. See the [documented InnoDB duplicate-lock behavior](https://docs.oracle.com/cd/E17952_01/mysql-8.0-en/innodb-locks-set.html). That is not a production performance or scheduler-causality proof. Unit tests cover orphan detection, terminal holds, skew boundaries, continuation envelope validation, serializable replay denials and adapter failures. Required exact-head CI and operator approval remain separate deployment gates.

A safe rollback stops new marked starter production but retains the dual-reader handler for already queued marked histories. Do not delete owner rows, auto-unpark, cancel runs or revert to a marker-ignorant handler as rollback shortcuts.
