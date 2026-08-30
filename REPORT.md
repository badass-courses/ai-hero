# Report: contact-event-hotpatch

Worker: contact-event-hotpatch worktree, branch `worker/contact-event-hotpatch`, commit `cfbbba8` (author `shitratgit[bot]`). Not pushed.

## What changed

12 files, +1335 / −1. All under `apps/ai-hero/` (monorepo — the brief's `src/...` paths resolve there).

New:
- `src/lib/subscriber-marketing/lifecycle-contact-events.ts` — core module. Types, semantic-key builders, event builders, and preview/write pairs for both event types. Shared by forward capture and backfill so both paths dedupe on the same keys.
- `src/lib/subscriber-marketing/lifecycle-contact-events.test.ts` — 11 tests.
- `src/inngest/events/contact-unsubscribed.ts` — `email-preferences/contact-unsubscribed` event type.
- `src/inngest/functions/capture-purchase-contact-event.ts` — inngest fn, triggers on `commerce/new-purchase-created` and `commerce/full-price-coupon-redeemed`, inngest idempotency on `event.data.purchaseId`, loads the purchase + user, writes the ContactEvent.
- `src/inngest/functions/capture-contact-unsubscribed.ts` — inngest fn on the new unsubscribe event.
- `src/scripts/backfill-contact-events.ts` — backfill script (`pnpm contact-events:backfill`).

Modified:
- `src/lib/email-preferences.ts` — `sendContactUnsubscribedCaptureEvent` helper; hooked into `updateProviderEmailPreference` (fires only when the request was an unsubscribe AND the provider state confirms unsubscribed) and `unsubscribeLocalEmailPreferenceByUserId` (legacy user-id links). Fire-and-forget: emit failure logs a warning, never breaks the preference flow.
- `src/app/(email-list)/preferences/actions.ts`, `src/app/(email-list)/unsubscribed/page.tsx` — pass `subscriberEmail` through (the API route already did).
- `src/inngest/inngest.config.ts`, `src/inngest/inngest.server.ts` — register the two functions and the event schema.
- `package.json` — `contact-events:backfill` script entry.

## Event types and semantic keys

| Event type | Provider | Semantic key |
|---|---|---|
| `purchase.recorded` | `ai-hero` | `ai-hero:purchase.recorded:purchase:{purchaseId}` |
| `contact.unsubscribed` | `kit` | `kit:contact.unsubscribed:{lowercased email}:{preferenceKey}` |

Both keys are deterministic from the source record, so forward capture and backfill collide on `ContactEvent_semanticIdempotencyKey_uq` by design and the write path skips duplicates before insert. `occurredAt` is real: `purchase.createdAt` / preference `optOutAt` / the moment the opt-out was confirmed. Provenance: purchase events carry `providerEventId purchase:{id}` and `providerReference ai-hero:purchase:{id}`; unsubscribe events carry `providerEventId email-preference-opt-out:{key}:{email}` plus the source path in the payload summary.

## Deliberate deviation: direct write, not `captureNormalizedContactEvent`

The brief said "through the existing capture path." I did not run these through `captureNormalizedContactEvent`, and this is the load-bearing decision: its classifier keyword-matches the taxonomy — 'purchase'/'buy'/'refund' map to a 'buying' review signal, and any event without strong keyword hits scores 0.25 confidence → 'low-confidence' + 'ambiguous' → `humanReview=true`, which is **sticky** in `reduceContactState` and flips lifecycle to 'human-review'. Running 17k purchases plus unsubscribes through it would poison live contact states mid-launch.

Instead I used the repo's other existing capture pattern — the preview/write split from `contact-event-normalizer-preview.ts` (the `content.read` / shortlink precedent): direct `createContactEvent`, no classifier, no ContactState mutation, no side-effect intents. Tests assert states/transitions/nextActions/sideEffectIntents stay untouched.

Identity resolution is conservative: existing contacts only. Ladder: (`ai-hero`, userId) identity → (`kit`, kitSubscriberId) identity → contact by userId → contact by email. A contact found without an ai-hero identity gets one created (write mode only), reusing an existing identity when the (provider, externalId) slot points at this contact and skipping on genuine conflicts. Unknown purchasers/emails are skipped — no provisional contacts, so drovr replays see purchases only for people already in the contact universe.

## Backfill dry-run counts

Command (from `apps/ai-hero`, read-only, **no `--live` run ever executed**):

```
SKIP_ENV_VALIDATION=1 DOTENV_CONFIG_PATH=<main checkout>/apps/ai-hero/.env.vercel pnpm contact-events:backfill
```

(`SKIP_ENV_VALIDATION` needed because `.env.vercel` lacks unrelated course-sync/dropbox vars; `DATABASE_URL` presence verified by grep count only, value never read.)

Purchases (status Valid/Restricted, LEFT JOIN users):
- rows 17,399 · eligible 2,631 · skipped 14,768 (all `no-existing-contact`) · written 0
- resolution paths: contact-by-userId + create ai-hero identity 2,619 · existing ai-hero identity 12

Unsubscribes (local CommunicationPreference mirror, active=false, optOutAt set, Email channel):
- rows 940 (940 usable, 0 unknown preference types, 0 non-email channels) · eligible 38 · skipped 902 (`no-existing-contact`) · written 0

The 85%/96% skip rates are the conservative design, not a bug: the contact universe is ~19.6k newsletter-derived contacts, and most historical purchasers / opted-out account holders never entered it. If Joel wants those people represented, that's a deliberate follow-up decision (provision contacts during backfill), not something a worker should do unilaterally against prod.

## Unsubscribe data-source finding

There is **no Kit→ai-hero unsubscribe webhook.** Unsubscribes reach ai-hero only through its own preference flows, all of which funnel through `src/lib/email-preferences.ts`:
- `updateProviderEmailPreference` — preferences page, unsubscribe links with `ck_subscriber_id`+`sh_kit`, admin/CLI, API route. Forward capture wired here.
- `unsubscribeLocalEmailPreferenceByUserId` — legacy user-id unsubscribe links. Wired here too.

Historical gap, stated precisely: anyone who unsubscribed inside Kit's own UI/footer (never touching an ai-hero page) has no local record. The local `CommunicationPreference` mirror covers only account-holders whose opt-out passed through an ai-hero flow — those 940 rows are the entire locally knowable history. I did not fabricate the rest. Closing the gap forward-only would need a Kit webhook or periodic Kit API reconciliation; both are out of scope and launch-sensitive.

## Commands run and results

From `apps/ai-hero` in the worktree:
- `pnpm typecheck` — pass (after fixing one TS error in the backfill script: preference-type map widened to `Map<string, EmailPreferenceKey>`).
- `pnpm test` — 246 files / 1,912 tests pass; 5 files / 5 tests fail (module-progress-provider ×2, skills-hero, skills-install-options, agent-token-route-behavior, markdown-routes). **Pre-existing:** the identical 5 fail in the untouched main checkout at the same commit `cdcf52e`; none import anything I touched.
- `pnpm vitest run src/lib/subscriber-marketing/lifecycle-contact-events.test.ts` — 11/11 pass.
- `pnpm lint` — exits 1 with 19 errors / 46 warnings, zero in touched files; main checkout baseline is 21 errors / 46 warnings. Pre-existing debt.
- Backfill dry-run: counts above, exit 0. Sanity run with `--limit 25` first.

## Open risks

- **Refunds/chargebacks not captured.** Only `purchase.recorded` at creation; a later status flip to Refunded emits nothing. Replays will overcount if that matters.
- **Unsubscribe key dedupes to first occurrence.** `{email}:{preferenceKey}` means unsubscribe → resubscribe → unsubscribe records only the first opt-out. Fine for parity with current data; wrong if re-unsubscribes must be distinct events (would need occurredAt in the key, at the cost of backfill/forward dedupe).
- **Skipped-by-design population.** 14,768 purchases and 902 opt-outs are invisible to replays until a contact-provisioning decision is made.
- **Forward purchase capture depends on user email/customerEmail resolution** matching an existing contact at purchase time; brand-new buyers who aren't subscribers will skip (consistent with backfill).
- **`--live` exists but has never been run.** Running it is an operator decision; it writes to whatever `DATABASE_URL` the env provides.
- Inngest fns are registered via `inngest.config.ts`; they go live on next deploy. Launch-mode note: they only append ContactEvents and cannot touch Kit sequences, checkout, or signup.
