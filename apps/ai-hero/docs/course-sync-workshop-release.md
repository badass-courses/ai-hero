# Managed cohort workshop releases

C5 contract v8 accepts managed workshops in `draft` or `published`, always `unlisted`. New workshops still start `draft`. Release is an operator action, not a source-manifest instruction. `startsAt` gates timing once a workshop is published. Managed lessons stay `draft/unlisted`; videos stay `ready`.

Sync treats workshop state as operator-owned only for a release-aware v8 binding. Preview shows the current state. Apply reads it from the locked row, so a release after preview also survives. Source-field hashes exclude workshop state for that binding. Rollback restores source fields without reverting release state, including when the parent version predates release. Rolling back a create still detaches its relation; keeping `published` does not keep that relation attached.

The Crash Course v4 binding and the exact C5 v5/v6/v7 literals are unchanged. Only exact stored C5 literals migrate to v8. Unknown edits remain immutable-binding conflicts. Existing previews made before the binding migration must be restaged, not applied with the old contract/hash.

## Operator release script

Run from `apps/ai-hero` with an approved `DATABASE_URL` already injected into the environment. Do not print or commit credentials. The script is dry-run by default. It neither migrates bindings nor calls the sync API.

```sh
# Read-only eligibility check. Prints ids, states and dryRun, never content.
pnpm exec tsx scripts/release-managed-workshop.ts \
  csb_ai_hero_cohort_005 sync_workshop_cbd8bc33e2d48b0dabc13c08

# Only after deployment, stored v8 migration, plan review and separate write approval:
pnpm exec tsx scripts/release-managed-workshop.ts \
  csb_ai_hero_cohort_005 sync_workshop_cbd8bc33e2d48b0dabc13c08 --allow-write
```

The script locks the binding, workshop and its live parent relation in a transaction. It refuses unless the stored contract is the exact active v8 literal and the target is an undeleted, unlisted, managed workshop with exactly one managed relation under the bound cohort. It requires `draft` before release. It updates only `fields.$.state` with `JSON_SET`, requires one affected row and verifies the state readback before commit. It leaves scheduling, content, current-version pointers and entitlements alone. A repeated release refuses rather than overwriting `published` or another non-draft state.

## Staged deployment and proof

1. Merge and deploy code after CI passes. No workshop becomes published just from deployment.
2. Let the normal binding-ensure path migrate the exact stored v7 contract to v8. Read back the stored contract and migration receipt. Do not release against v7. Restage any pre-migration preview.
3. Review a fresh sync plan for the binding. Confirm only intended source changes, no workshop create without review, unchanged lesson/video contracts, and existing `startsAt` values intact. Record the plan hash.
4. Run the release script without `--allow-write`. Review the exact binding/workshop ids and the `draft` to `published` transition. Obtain the separate go for that write.
5. Run the approved command once with `--allow-write`. Capture its ids-only readback receipt. Confirm the workshop opens for an entitled learner when its schedule permits. Before We Start has no scheduled start; do not remove dates from the other workshops.
6. At the next authorized sync, confirm target validation succeeds and the released workshop stays `published/unlisted` through preview/apply. Confirm the other workshop dates and draft lessons are unchanged.

No production writes, environment changes, sync API calls or release-script executions were performed to prepare this change.

## Rollback

Undo the workshop release before deploying the old code, since v7 rejects published children:

```sh
# Inspect the inverse transition first.
pnpm exec tsx scripts/release-managed-workshop.ts \
  csb_ai_hero_cohort_005 sync_workshop_cbd8bc33e2d48b0dabc13c08 --state draft

# After separate write approval:
pnpm exec tsx scripts/release-managed-workshop.ts \
  csb_ai_hero_cohort_005 sync_workshop_cbd8bc33e2d48b0dabc13c08 --state draft --allow-write
```

`--state draft` requires the prior state to be `published` and changes only that state. Revert the code through the normal deploy process. If the stored row has already migrated to v8, reverting code alone is not enough: the old binary rejects a v8 stored binding. Keep the v8 reader/migration support or have the binding owner separately approve and restore the exact v7 stored literal after all released workshops are draft. This script deliberately cannot downgrade a binding contract. Never fix the mismatch by editing lesson/video contracts or silently weakening exact-literal validation.
