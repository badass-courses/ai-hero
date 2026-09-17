# Contact email projection rollout plan

Not an executable migration runner. No production application, backfill or activation follows from this file.

## Order

1. Separately approve, apply and verify the additive SQL plan, generated-column expression and both nonunique indexes on the target provider. Verify the raw column is utf8mb4; the source digest is over its UTF-8 bytes. Native MySQL results do not attest a proxy/provider.
2. Only then deploy the migration-dependent table declaration and repository writes, or run their live CLIs. Existing unqualified Contact selects include the new columns even with the observer disabled. Do not run `db:push` from this or an older checkout.
3. Separately approve bounded backfill and whole-table verification. Keep observation disabled throughout. Preserve every Contact ID and raw email, including duplicate and blank/null values. Record unrepresentable rows as failures rather than silently skipping them.
4. Verify deployed query plans, representative provider concurrency/lock cost and login latency. Obtain separate activation approval.

## Exact bounded backfill algorithm

Use Node24 with Unicode17.0 and the shipped `contactEmailWriteValues` helper. Key generation refuses another major/Unicode version; verify this runtime before deploying compatible writers as well as before backfill. Fixed normalization/HMAC/key vectors pin the v1 behavior. No SQL TRIM/LOWER, Unicode NFC, alias or address-grammar conversion.

Read a bounded primary-key page in ascending id order, selecting `id,email`. Keep raw strings private; do not log them or their linkable hashes. For each row, compute all values from that one raw snapshot. Do not modify raw email during backfill.

The conditional write is:

```sql
UPDATE AI_Contact
SET emailKey = ?, emailKeySource = ?
WHERE id = ?
  AND CAST(email AS BINARY) <=> CAST(? AS BINARY);
```

Bind the computed key/source, id and the original raw email. The null-safe byte comparison is necessary: default case/accent-insensitive equality is not a raw-value CAS. A newer equivalent spelling must win rather than receive the old source hash. For NULL raw email, write NULL key/source.

Read back the row after each conditional attempt. Require exact raw snapshot equality and exact recomputed key/source plus stale=0; a zero affected-row count alone is not proof of either failure or success. If the raw value changed, re-read/recompute with a bounded retry count. Leave unresolved rows reported and capture disabled. Never reuse a computed projection against another raw snapshot. Persist page progress only after all rows in the page are either verified or explicitly recorded as unresolved; resume by the last primary key, not OFFSET.

Final verification must visit every row and recompute raw-source and JS key, not merely count stale=0. Count missing/malformed/wrong-version projections and preserve all equivalent IDs. The generated flag detects legacy changes, but cannot authenticate a malicious writer that coherently forges key and source. Later owner/claim checks remain fresh.

## Version boundary

Current contract: `v1:` plus64 lowercase hex, width67; hash input `JSON.stringify(['aih:contact-email:v1', raw.trim().toLowerCase()])`. Source is SHA256 of raw UTF-8, without normalization. The migration expression and schema share the checked contract; a test rejects SQL-plan drift.

Changing the algorithm/runtime normalization semantics requires coordinated writer/backfill and generated-expression invalidation. Merely changing the hash input or lookup prefix hides old rows. The global generated flag must expect the new version so mixed old rows hold before any proof INSERT. No static ready flag replaces that invariant.

## Lock behavior and limits

The observer locks the stale=1 range before exact key lookup inside its owned transaction. One stale row intentionally holds all observations. An empty boolean-index gap can also block a conforming insertion at the boundary. Do not promise unrelated inserts never block. Index-plan estimates, synthetic races and actual provider latency are separate evidence.

Missing or unsupported schema must hold, with no raw/normalized-scan fallback and no post-COMMIT downgrade. Do not deploy migration-dependent code before verified DDL as a way to exercise that failure path.
