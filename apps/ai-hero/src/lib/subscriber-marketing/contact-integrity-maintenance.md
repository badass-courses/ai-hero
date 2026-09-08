# Contact integrity maintenance

Source-only operator tooling. Nothing here approves production access or activates observation. Apply and verify the accepted additive DDL before migration-dependent application code. Keep the fresh indexed stale-range lock in the login/claim path after maintenance.

## Offline entry

```sh
pnpm --filter ai-hero contact-integrity:maintenance --mode plan
pnpm --filter ai-hero contact-integrity:maintenance --help
```

No database constructor, dotenv, application database import, credential read or provider call runs in help/plan. Normal output is a versioned redacted JSON envelope. Unknown flags fail closed. `approvalGranted` and `unqualifiedReady` are never true.

## Separate approval and credential boundary

Every database mode needs an actual separately approved packet identifying the exact source, target, mode, budgets and private cursor inputs/outputs. `--approval-ref` and `--acknowledge-approval` record the caller's assertion; they are not authorization. Dry-run also reads Contact data and needs approval. Do not run these examples against production merely because the command exists.

After that approval, supply credential JSON through an inherited fd numbered 3 or higher, not through command-line secret values or application environment variables. Do not copy application credentials. The envelope has these fields:

- `purpose`: `contact-integrity-maintenance`
- `target`: exactly the approved non-secret target label
- `host`, `port`, `database`, `user`, `password`, `tls`, optional `ca`
- Dedicated user: `aih_contact_maintenance_reader` for inspect/dry-run/verify; `aih_contact_maintenance_writer` for apply. The command checks `CURRENT_USER()` as well as the supplied name. Account provisioning and privileges need their own approval. Use SELECT and, for the writer, column-scoped UPDATE on emailKey/emailKeySource only.

No credential URI, dotenv or application credential fallback exists. TLS certificate verification is required. The sole non-TLS exception is `target=disposable-ci`, `CI=true`, and the existing localhost-only MySQL integration guard. Native tests are synthetic; this is not a production bypass. Credential input is capped at 16KB; close the supplying pipe or use an inherited private regular file. Never log or publish that file.

A future approved invocation has this shape (fd 3 must already be supplied):

```sh
pnpm --filter ai-hero contact-integrity:maintenance \
  --mode dry-run --target approved-target --approval-ref approved-packet \
  --acknowledge-approval --credential-fd 3 \
  --page-size 100 --max-rows 1000 --max-writes 100 --max-ms 10000 \
  --state-out /private/path/new-page-state.json
```

This example supplies no credentials and is not an approval packet.

## Modes and limits

- **inspect**: checks actual column types, UTF-8 transport/raw email, ASCII binary key/source widths, InnoDB, required visible nonunique indexes and exact generated-guard AST. It does not read Contact rows or certify data. It is not EXPLAIN, locking or latency evidence.
- **dry-run**: ascending primary-key page reads; recomputes the exact accepted Node24/Unicode17 projections. No writes. Counters cover only this invocation, not prior cursor pages.
- **apply**: updates only key/source with the accepted null-safe raw-byte CAS. It never updates email, IDs or unrelated fields. Each acknowledged attempt is followed by exact raw/projection/stale readback. Changed/deleted rows go to the private unresolved list; unknown acknowledgement or failed readback stops before advancing past that row. No automatic wider WHERE or hidden retry.
- **verify**: a new complete read-only consistent snapshot, with no resume cursor. It recomputes every covered row, including raw-byte round-trip checks and exact JS equivalence groups. It performs no Contact writes.

Limits: page size 1–500; inspected rows 1–100,000; attempted writes 0–10,000; database-operation budget 100–60,000ms. One extra row can be fetched as an exhaustion sentinel. Query timeouts close the exclusive connection; an uncertain UPDATE is never success. Connection setup has its own capped timeout; operator fd/file I/O is outside the database-operation budget. A write cap may stop apply before another page even if later rows would already match. Run a fresh verifier afterward.

Codes `partial`, `held`, budget/schema/runtime/transport failures exit 2. Only a completed operation exits 0. Completion of a resumed page does not mean the entire table is repaired.

## Private continuation

Dry-run/apply require `--state-out`, created exclusively with mode 0600 before connecting. Existing files are never overwritten. Resume with `--state-in` and a **new** `--state-out`. The private state is bound to mode, target and connection scope and contains the last processed ID, unresolved IDs and previous-state pointer. It contains linkable information, not anonymous data. Retain the entire state chain and redacted command receipts. A failed or empty state file is not a usable checkpoint.

A conflict can be explicitly recorded and passed by the page cursor. An uncertain write/readback retains the preceding cursor so resume retries that row safely. Changed rows and lower-ID inserts behind a cursor can be missed by a later page. Re-running a full pass and a new verification snapshot is necessary; never promote cursor exhaustion into whole-table readiness.

## Snapshot evidence, not perpetual readiness

Whole verification is supported only for native MySQL 8.4 Community/InnoDB here. Missing/other provider metadata fails with `unsupported-snapshot`; MySQL-compatible syntax does not establish provider transaction semantics. The known production metadata does **not** satisfy this narrow support check. Provider verification support remains a separate evidence gate, not a flag to assert away.

The verifier establishes REPEATABLE READ with `WITH CONSISTENT SNAPSHOT, READ ONLY`, acquires the Contact metadata lock and rechecks schema while holding it. Database timestamps bracket snapshot establishment (`snapshotStartedAt` through `snapshotEstablishedBy`) and record scan end. These are observation times, not binlog coordinates. Truncation or uncertainty cannot set `snapshotProjectionValid`.

After COMMIT, a separate autocommit, nonlocking global-stale query reports its own time/result. A concurrent coherent writer or insertion may leave that guard at zero while changing duplicate groups after the snapshot. Therefore even a complete, exact snapshot plus a clean later guard is **not all rows now** and never sets `unqualifiedReady`. Later login/claim ownership and stale-range locks remain mandatory.

Ambiguous-group counts use exact JS normalized strings privately in bounded memory, including empty normalization. NULL rows have a separate count. No address grammar, Unicode normalization, alias folding or deduplication is added. Normal output includes no raw email, normalized value, row ID or linkable digest. Duplicates are preserved and reported, not merged.
