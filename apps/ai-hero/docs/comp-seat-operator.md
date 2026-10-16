# Comp seats with cohort early access

This command creates zero-amount cohort purchases without running the normal
post-purchase marketing workflow. It does not send purchase-created or
full-price-coupon events. The only event it can send is `cohort/user-added`,
and only when the product itself has a Discord role.

## Review before executing

Run from `apps/ai-hero` with the normal operator environment. The package script
loads dotenv the same way as `ads:operator`. Keep input and receipts private.
The input file contains one user id per line, not names or email addresses.
Use a non-sensitive reason because it is stored on the purchase.

```sh
pnpm comp-seat:operator --product-id <product-id> --user-ids ./ids.txt --reason 'cohort-comp'
```

Dry-run is the default. It reads the product, its single linked cohort, live
workshop relations, entitlement types, existing purchases and personal
organization membership. It writes nothing and sends no events.

The JSON receipt includes:

- `plan`: exact insert values for each purchase, entitlement, and any missing
  personal organization, membership, owner/learner roles or role assignments.
  Database-owned defaults such as creation timestamps are not supplied.
- `context`: cohort and workshop ids, entitlement type ids and the explicit
  product Discord role, if present.
- `planHash`: SHA-256 of the canonical plan, including reason, rows and skips.
- `counts`, `users`: counts and per-user outcomes keyed by id, never email.
- `rollback`: the rollback instructions.

Review the rows and copy `planHash` into:

```sh
pnpm comp-seat:operator --product-id <product-id> --user-ids ./ids.txt --reason 'cohort-comp' --execute --plan-hash <reviewed-hash>
```

Execution rebuilds the plan and refuses a different hash before writing anything.
It then locks each user row and revalidates that user's plan inside one
transaction. Personal organization setup, owner/learner membership, purchase
and all entitlements commit together. A failed transaction reports `failed`
without undoing other users who already committed. Review the receipt and
create a new dry-run for remaining users.

Any existing purchase of the product is skipped, regardless of status. Repeated
execution writes nothing for already-granted users. An old hash may be refused
because skips change the plan; review a new dry-run rather than bypassing it.

No product Discord role means `discord: "not_configured"`, no Discord
entitlement, and no Discord event. There is no environment-role fallback.
Discord events are sent after commit with a deterministic event id. A delivery
failure reports `delivery_failed` and exits nonzero; the purchase remains valid.
After verifying the grant, an operator can resend the exact `discordEvent` from
the receipt. A grant re-run skips purchases and does not retry Discord delivery.
There is no durable event outbox in this command.

## Access and workshops added later

`cohortModuleOpenFor(entitlement, module, now)` is the one pure decision used
by both cohort lesson rules. It requires the current module id in that
entitlement's `contentIds`. The date is open when `earlyAccess === true`, when
there is no start date, or when `startsAt < now`. String `"true"`, number `1`,
missing and false flags do not bypass the date. The existing strict start-date
boundary, role rules, free-content rules and visibility behavior stay intact.

Comp purchases store `fields: { source: 'comp', reason, earlyAccess: true }`.
Their entitlements use the existing transaction helper and `PURCHASE` source,
so the existing cohort entitlement discovery JOIN includes them. If the cohort
has no workshops yet, a content entitlement with `contentIds: []` acts as an
enrollment anchor. It grants no module access but lets discovery find the user.

The existing CMS and course-sync paths trigger the cohort entitlement sync.
`deliverCourseSyncEntitlementSync` calls `triggerCohortEntitlementSync`; the
workflow discovers purchasers and calls `syncUserCohortEntitlementsWithIds`.
That sync copies strict boolean early access from the valid comp purchase onto
new workshop entitlements. It prefers an active early-access comp when several
products grant the same cohort, and prefers the purchase's organization membership.
If that membership is missing, sync falls back to the user's first membership,
matching the legacy behavior. Refunded and disputed purchases remain excluded by the existing status filter.

## Rollback

Delete the comp purchase and its `sourceId`-linked entitlements together in a
transaction, including entitlements added by later sync. Alternatively, clear
`earlyAccess` on both purchase fields and all its entitlement metadata to keep
the seat but restore normal dates. Clearing only the current entitlements would
allow later sync to restore the flag from the purchase. Do not delete shared
personal organizations, memberships or roles. If a Discord role was already
assigned, database rollback alone does not remove it from Discord; handle that
provider action separately.

## Verification receipts

- Red first: the ability property test failed for boolean true at the date
  boundary before implementation. The later-workshop sync test failed because
  newly created entitlements had no early-access flag.
- Properties use fast-check with seeds `5417` and `5418`, 500 cases each, across
  strict/truthy/missing flags, dates, module scope, and direct/section lessons.
- Planted truthiness mutation (`Boolean(earlyAccess)`) failed four tests.
  Minimal counterexamples included `['true', 0, true]` and `[1, 0, true, 'direct']`.
- Planted unrelated-module mutation (remove the helper's content-id check)
  failed the pure property with `[true, undefined, false]`.
- Both mutations were removed. Repository tests exercise the actual entitlement
  helper against a synthetic transaction executor. They check planned ids,
  `PURCHASE` sources, rollback on insert failure, no commerce events, the
  no-Discord path and no writes on repeat. These are not live MySQL tests.
