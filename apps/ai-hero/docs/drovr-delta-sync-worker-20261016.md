# Consumer-first frozen-profile ACK worker milestone — 2026-10-16

**PR #428 remains draft. `drovr-profile-ack-enabled` remains OFF. No merge, deploy, stored flag change or production HTTP/SQL is authorized. This is not the finish packet or permission to enable.**

## Implemented

- Actual native settlement and direct replay route known frozen profile/link identities through the shared atomic settlement/completion transaction. Only explicit all-positive receiver acceptance may promote their native rows to delivered; mixed/refusal counters and prose are not authority. A later hold stays held, and failed ACK writes roll back native settlement and confirmation together.
- The actual SDK ACK effect calls stored-request completion, with fresh original membership and frozen-clock proof inside the transaction. A failed effect cannot reuse an earlier cached positive subset proof or fall back to legacy NOW. ACK-only empty requests are supported without transport or capture.
- `profileAckRef` and `profileAckNativeDebt` are separate SDK metadata. Raw shards, physical retries/renewals, native queue replay and held release preserve the frozen identity without putting it in wire bodies. Held scope comparison refuses identity replacement.
- Frozen SDK consumers read retained ownership only and do not re-run mutable ownership fan-out. Admission runs before ownership/booking and again inside the actual POST callback. Missing evidence is terminal typed `AckEvidenceExpired`, not a receiver refusal, SDK ACK retry, recapture, new pin or timestamp refresh. Late failure hooks cannot resurrect a frozen SDK body.
- Native debt is not canceled by ACK expiry. Existing native profile debt may settle independently without an ACK; a surviving link never gains fabricated missing profile authority. Native accepted counts are transport facts, not frozen-request confirmation; awaiting/expired ACK receipts are not reconciliation coverage.
- The legacy Drizzle age writer uses contact-first transaction ordering and refuses NOW refresh for known frozen identities even OFF, and optimistic ACK while ON. Never-registered OFF behavior remains legacy-compatible.
- Expiry logging is bounded **process-local** LRU suppression of hashed contact/version keys, not Redis/distributed exactly-once logging. Concurrent second calls are suppressed; fresh Node processes can each log once, and eviction permits re-log. Logger failures stay quiet and cannot retry the terminal ACK.

## Local evidence for this milestone

- Current workflow selection: **570 actual disposable-MySQL tests / 30 files, zero skips** (564 main-group + 6 activation-group). The fixture is desk-owned MySQL 8.4 on loopback:3307; no teardown performed.
- Complete MySQL-log audit: no configured patterns hit. Log SHA-256: `6d0a883a0b7e692db0fdca0c4cdc8e59eab12a205668574153dcbc64eaae0bca`. This pattern audit is **not** whole-network isolation.
- Exact current CI unit selection: **3,398 passed / 233 files**, with **481 intentionally guarded tests skipped / 23 files** outside their disposable-server job. The separate actual MySQL workflow above has zero skips.
- Focused SDK/admission/held/logger selection: **191 passed / 8 files**. Fresh-process logging tests use real Node 24 child processes. Real SQL tests additionally cover live-port awaiting/completion/expiry, unchanged native replay bodies, ACK-only frozen clocks, and missing required control storage on the 129th-member proof chunk.
- Six targeted worker/logging mutants killed and restored: missing actual-POST recheck, recapture during frozen ownership, removal of explicit positive settlement authority, missing process-local suppression, legacy NOW fallback in the frozen SDK ACK effect, and late failure-hook recapture.
- One full-suite attempt hit `ER_LOCK_DEADLOCK` in the untouched checkout-reconciler race test; the next complete 570-test run passed. The failed log is retained privately at `.git/dsync-worker-checkout-race-first.log`. Main comparison is separate; no checkout fix is included in this PR and an isolated failure is not proof that it predates this branch.
- Classic TypeScript reports only four previously recorded untouched diagnostics: three entitlements MySQL generic errors and one purchase-fields recursive return annotation. No touched-file diagnostics. Remote exact-head native typecheck/build/CI must be verified on the pushed worker commit; previous checkpoint CI is not new-head proof.

## Still required, in approved order

1. Immutable atomic first capture plus ACK registration before publication; producer/memory-store integration, known coordinator/tombstone lookup and honest mixed-old-SDK unavailable states. Consumer readiness does not mean this lifecycle already exists.
2. Dedicated first-created +400-day / positive-version-change tombstone expiry and late-duplicate/lifetime proof.
3. Remaining N7 native family/parent-child/healthy-gate closure, N13 current-offer and retained-restatement audits, worst-case actual-fetch timing, operator/deploy-order proof and final audits/checks.

The approved main merge `ac0fcffeadd306432a11a62204e2d3c2cb0fd344` and separate broker-leak test fix remain in the graph. New metadata is a one-way compatible-reader boundary, not a flag-off/old-code rollback strategy. Do not enable while the remaining producer and lifecycle requirements are open.
