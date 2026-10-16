# Delta-only contact sync: immutable first registration checkpoint

PR #428 remains **draft**. **`drovr-profile-ack-enabled` remains OFF**. No deployment,
merge, enablement, production SQL/HTTP or new DDL is authorized by this checkpoint.
It follows worker-consumer commit `bd10a4e7abeb9f1c405e822b12f1304db9717adb`, whose
exact-head remote CI/typecheck/build/MySQL/e2e/security checks passed. Those checks
are historical evidence, not remote validation of this subsequent checkpoint.

## Implemented

- The root producer uses a distinct immutable SDK preparation result: fresh frozen
  capture, an actually retained known reference, never-registered disabled work,
  or logical unavailable. Unavailable has no fabricated requestId/coordinatorKey.
- A genuinely created/bumped version exposes opt-in new-code SDK provenance.
  Unchanged versions and old SDK memos do not acquire that provenance retroactively.
  The provenance is neither an enable flag nor a receiver proof.
- A successful earlier SDK effect records **database UTC** registration epoch.
  Ancient first-capture memos cannot restart after the metadata lifetime. Actual
  capture obtains fresh DB UTC too; no session SET, environment clock or app-time
  substitution. This epoch never authorizes ACK age.
- The actual capture transaction locks contact/version authority first, looks up
  known coordinator/member/tombstone references **including OFF/error**, then
  captures native rows and installs the whole frozen roster/pointers atomically.
  Every 128-row chunk requires the real control column. Concurrent legacy capture,
  metadata failure or later missing-column failure rolls the new capture back.
  First bytes, source, clock and original membership are never overwritten.
- No broker/HTTP callback runs in the transaction. Publication occurs only after
  commit and reads retained original native bodies, with the reference outside
  wire bodies. Its stable publication identity is derived from the full frozen
  request. Healthy native gates retain debt without claiming a publication.
- Known requests are completion-only. A failed SDK memo after committed capture
  does not repeatedly publish or rebase the native +24-hour replay lease; native
  replay remains responsible for its owed original rows.
- Fresh admission fences even cached successful SDK results. The actual ACK
  effect calls atomic stored-request completion, not boolean subset/counter proof
  followed by legacy NOW. A failed write with an intervening hold cannot reuse a
  cached positive grant. Missing evidence is terminal `AckEvidenceExpired`.
- Memory confirmation uses the same original-roster/first-proof policy and frozen
  delivered-profile `occurredAt`. January delivery accepted in March still ages
  January. Same proof is a no-op; backward movement literally refuses
  `CONFIRMATION CLOCK WOULD MOVE BACKWARD`. Native transport counts remain separate
  from reconciliation coverage.
- The legacy writer now reports whether it actually wrote. Known identities,
  repeated unknown old ACKs and same-period confirmation retries cannot silently
  return optimistic success. A distinct OFF monthly legacy request names its
  period explicitly. Genuine offers remain independent.

## OFF / mixed-SDK safety boundary

A retained reference is never classified as never registered merely because the
flag is OFF. After finite metadata retention, **absence alone is also insufficient**
to retrofit an old/unchanged unacknowledged version. A genuinely fresh new-code
version or distinct monthly request can use the never-registered OFF road; an
ambiguous old SDK or ancient first-capture memo instead returns logical unavailable,
without capture, publication, a new pin or a NOW refresh. Existing native debt
remains independently replayable. An OFF preparation already memoized before a
flag change cannot become ON registration after legacy publication.

The source-pinned main oracle remains a local compatibility model, not production
POST/age telemetry or proof that every mixed-old-SDK request can make progress.

## Validation and remaining work

Local checkpoint validation: **3,416 passed / 235 unit files**, with 493 guarded
SQL skips in 23 files for the exact CI unit selection. The separate **complete
30-file SQL workflow passed 582 tests (576 + 6), zero skips**, including the
schema-build prerequisite and final activation group. Six targeted registration /
SDK / legacy-clock mutants were killed and restored. Classic TypeScript has only
the four recorded untouched baseline diagnostics; no touched-file errors. Protected
file hashes, approved main merge and separate broker-test fix remain preserved.

Complete SQL log SHA-256:
`cc8e2d7bf79455fe72f886665dae69424455f33a59b7d5ed53f3d79d909c17d2`.
The successful complete-log pattern audit found no configured hits. These are local
precommit-worktree results, not exact-head remote CI. Full SQL uses only the
authorized desk-managed disposable MySQL fixture, with `CI=true` and guarded loopback URLs. Log-pattern auditing is **not**
a whole-network isolation guarantee. The unrelated checkout deadlock was previously
reproduced on unedited main; no checkout implementation is changed here.

The old boolean-proof→legacy-NOW producer tests were replaced by explicit refusal
for that unsupported adapter and actual frozen SQL/memory failed-effect tests.
Digest/offer legacy regressions are explicitly OFF, not fake ON coverage.

The proofless restater `CURRENT_TIMESTAMP` skip write is removed: out-of-scope
contacts cannot claim receiver confirmation. **Selection fairness remains pending**;
removing the false age write is not a starvation fix. Also pending: dedicated
first-created+400-day/positive-version tombstone deletion and late-duplicate lifetime
proof; N7 native-family healthy-gate closure; N13 offer/retention and 31-day
same-period selection audits; worst-case actual-fetch/SDK timing; operator
inspect/release/abandon/concurrency/history/deploy-order acceptance. No completion
packet or enable recommendation is made.
