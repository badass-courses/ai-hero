# Course-sync apply verification

Apply activates resource pointers and relations inside one MySQL transaction. A failed check throws and rolls the transaction back. Do not clear a hold or retry because a poll projection reports zero failures; read the referenced run too.

## Checks, in order

Preparation reads the rows just inserted and checks:

1. `resource_preparation_count_mismatch`: resource count equals the plan's resource count.
2. `version_preparation_count_mismatch`: prepared version count equals the versions being written.
3. `receipt_preparation_count_mismatch`: persisted run-resource receipt count equals the plan's resource count.

Activation checks:

1. `resource_count_mismatch`: readback resource count equals the plan's resource count.
2. `resource_or_receipt_missing`: each planned target has a resource and receipt.
3. `pointer_mismatch`: each current-version pointer equals its receipt's version.
4. `fields_mismatch`: whole resource fields match the expected merge of source fields and locked operator fields.
5. `relation_count_mismatch`: each resource has exactly the expected number of live, in-scope relations, at most one.
6. `relation_mismatch`: each expected live relation has its exact parent and position.
7. `tombstone_mismatch`: each expected dead relation exists at the expected parent/position with this transaction's exact timestamp.
8. `unexpected_tombstone`: no other in-scope relation was tombstoned by this transaction. Older historical tombstones are allowed.

Binding-tagged relations and relations under known current/previous tree parents are in scope. Untagged relations outside that tree remain untouched. The verifier reads dead rows too. It does not infer a child's detach from its parent's detach, and it does not require dead rows to occupy contiguous positions. Source plans supply survivor positions; integration tests verify their contiguity separately.

## Cross-parent move repair

The old writer activated a moved resource's new parent without retiring its former live parent. Readback then found two live relations. The verifier correctly rejected the transaction with `relation_count_mismatch`.

Apply now tombstones the locked prior live edge atomically with the new edge and version pointer. Activation verifies both edges: one live new parent and one current-transaction tombstone at the previous parent/position. Previously detached edges keep their historical timestamps. Same-parent repositioning remains one upsert. Rollback restores the previous parent and tombstones the new one.

## Telemetry

`course_sync.apply_verification_failed` logs the failing check, numeric counts, run ID, binding ID and plan hash through the existing server logger. Activation diagnostics include expected/readback resources, receipts, detaches, moves, relations, and failing-resource live/tombstone counts. Preparation diagnostics report expected/prepared resources, versions and receipts.

There are no resource fields, titles, bodies, media paths or credentials in the payload. A logging failure falls back to the same safe console payload and never masks the verifier error or prevents rollback. Activation errors also retain the check name in the run's failure reason. HTTP 500 responses remain redacted.

## Recovery after deployment

This is a recipe, not permission to execute it.

For an unchanged source and a fully rolled-back failed run, **neither re-stage nor re-preview is required**. The existing immutable preview is still the approved plan. `preview` accepts a staged run, not a failed run; calling it on a failed run does not refresh that plan.

1. Prove the deployed commit includes the repair. Read the failed run, binding, poll head, stored plan and latest applied run.
2. Recompute the plan hash. Re-read the live source and every frozen media revision/byte count. Confirm they still match the approved preview.
3. Recheck the exact detach and move sets, direct and descendant media, regressions, child state/visibility, and complete cohort/product field hashes. Check all existing pointers/source-owned fields and prior relations against the preview's preconditions.
4. Prove the failed transaction left zero new resources and zero run-resource receipts. Confirm the operator poll gate still points to this run, with no competing staged/previewed/applying run.
5. Obtain recovery authorization. Submit `POST /v1/course-sync/runs/{failedRunId}:apply` using the **original failed attempt's `Idempotency-Key`**. A different key is rejected. Do not call release, reset, or stage merely to bypass the failed head.
6. Independently verify run `applied`, exact live source order, children draft/unlisted, anchors unchanged, one live parent for every survivor, all approved detaches dead, and the moved resource's former edge dead/new edge live. Verify the poll is `succeeded`, failures zero, override cleared, and version receipts/pointers complete.
7. Record the applied run and plan hash as the whole-run rollback point. A later applied head or target drift can block compensating rollback.

If the source, targets or plan differ, stop. The unchanged-plan retry recipe no longer applies. Request a new recovery decision and use the normal authorized stage/preview path; do not silently refresh an approved plan.

Write new immutable dated receipts for:

- recovery preflight, including deployment proof, source/media readbacks, approved scope, complete anchor hashes and zero-residue proof;
- the one apply HTTP response, status, original idempotency key and timing;
- independent post-apply syllabus/visibility/anchor/relation/pointer/receipt/poll readback and rollback point;
- or, on failure, the named check/counts and fresh rollback/no-residue proof, without an automatic retry.

## Real MySQL regression

Set `AIH_COURSE_SYNC_MYSQL_URL` to a disposable loopback MySQL 8 database named `course_sync_verifier_test`, then run:

```sh
pnpm exec vitest run src/course-sync/drizzle-persistence.mysql.test.ts
```

CI runs this suite against a separate disposable database in the existing `MySQL contract` job, before the other MySQL suites. The suite refuses other hosts/database names and never reads `DATABASE_URL`. It derives fixture DDL, including unique keys and timestamp precision, from the installed schema and uses the production pool result wrapper and Drizzle adapter. Fixtures contain only synthetic content.

The main case has 204 resources: 77 creates (6 lessons), 104 updates, 23 retains, 38 media items, 8 workshop/59 lesson detaches, survivor repositioning, and one cross-parent lesson move. It checks apply and compensating rollback. Other cases cover original-key recovery of a failed head, historical tombstones, untouched unmanaged relations, and verifier/telemetry failures rolling back all writes.
