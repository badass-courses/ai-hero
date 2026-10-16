# drovr outbox runbook

`AI_DrovrOutbox` keeps every drovr send that ran out of retries, and every stop that is owed (rows 204, 204b and 204c). The replay (`drovr-outbox-replay-v1`, cron `2-57/5`) re-posts them under their drovr idempotency keys, so a repeat is deduped by drovr. Every statement below is a **prod write**: the hawk decides, and the row ids go in the receipt.

## Contact deltas and the paced lane

Profile/link deltas and complete backfill pages persist every immutable event **before** publication. An unavailable/unconfigured capture fails closed, so it cannot advance the watermark or acknowledge the new version. Captured rows give the queued worker a **24-hour not-before window**, rather than being immediately due to replay. Accepted nondeferred rows are settled **by key on the first attempt**, not only on an Inngest retry. Deferred, outboxed or held rows are not declared delivered. With `drovr-profile-ack-enabled` **OFF**, the producer intentionally preserves main's legacy optimistic ACK of successful delivery **or durable queue handoff**, avoiding repeated unacknowledged-version sends. This rollout trade-off is **not receiver-proof confirmation**. When **ON**, only fresh complete proof of frozen original profile/link membership may authorize the new atomic ACK; queued/deferred work is not confirmation.

- Source classes `bulkDelta`, `bulkRestate`, `bulkIngest`, `bulkBackfill` and `bulkEvergreen` preserve ownership without a schema change. Timed-out capped rows return to the same isolated worker. Replay CAS-leases a due pending row **before** publication; a concurrent publisher loses that lease without sending. A successful handoff does not rewrite its lease afterward: a fast consumer's final-failure release remains due, and its original diagnostic is retained. Failed broker publication shortens only the matching lease to a short retry; changed/settled leases are not reopened. Queue outcomes distinguish `published`, healthy `deferred` and `stale`, without charging HTTP attempts or the Drovr outage breaker. Generic bookkeeping cannot rewrite delivered or superseded history. Workers skip delivered rows and recheck after a durable wait. This is not whole-system exactly-once delivery; extreme overlaps still depend on receiver idempotency.
- Coupons and offers never change the profile digest/version. A genuine offer-only update and `coupon.issued` completion, including an offer-only straggler, stay live and uncapped. They cannot acknowledge a pending profile or postpone its confirmation.
- A profile/window bump queues the profile first and its links at the new version. **No old coupon snapshot rides that envelope.** Once the profile lands (including a previously delivered row), the same class queues a fresh offer lookup. That lookup reads the current coupon/version, keeps the coupon's issue timestamp and skips an obsolete profile version. Its POST is capped. The offer key already contains `couponId`; another coupon at the same profile version has another key.
- All capped classes share one UTC-asserted, row-locked JSON cursor with a 604ms grid, a 300ms actual POST-start authorization window and reserved sub-budgets: delta 60/min, confirmation 20/min, ingest 15/min, backfill 5/min; **100 events per sliding minute total** — **drovr report, observed 2026-10-15**. Every HTTP attempt reserves a new future slot and sleeps durably. Replay never bypasses those workers. The limit follows the receiver's report, but it is not a deployed AIH POST-start measurement; run the isolated timing proof before an approved batch.
- The quarter-hour **delta** reconcile and honest heartbeat remain independent of confirmations. Coupon/offer timeline rows remain coverage barriers and receive live offer-only repair; a failed repair cannot move `syncedThrough`. Unchanged acknowledged profiles emit nothing. OFF retains legacy optimistic queue-ACK coverage as the explicit rollout trade-off; ON, deferred/awaiting-proof is not receiver-confirmed reconciliation coverage. A rejection or capture failure cannot advance it. A no-change tick still reports its actual bounded watermark, not wall time.
- The monthly selector reads only `acknowledgedVersion = profileVersion`, oldest confirmation first. An unacknowledged restatement request takes the complete profile/link delivery. Equal-version confirmations use `profile:<contact>:<version>:restate:<YYYY-MM>` and the memoized issue time; they never carry changed values. ON, equal-version acknowledgement uses only that delivered profile's frozen `occurredAt`, never completion time, and may advance `acknowledgedAt` only forward without moving `updatedAt`/`since`. OFF retains legacy optimistic timestamp semantics. A matching legacy combined hash is rewritten at the same version and emits nothing on live sync; a differing legacy snapshot bumps normally. A format migration stays due for a later confirmation.
- Stored links retain their 120-day life and rotation at 90 days. drovr enforces the 30-day margin at render time and falls back to live personalize. AI Hero claims no due-time/horizon gate; the unwired horizon helpers are removed.
- The straggler remains: generic legacy capture can still fail during a storage outage, so exactly-once coverage of every old writer is **not** proven. It births each cold contact once per run, not once per link.
- A coded 409 `event-not-live` is the typed `deferred` status with a healthy +24h wait; whole-batch and per-item refusals retain their original event/key. An unrelated 409 is not transient merely because its diagnostic text mentions that phrase.
- **Receiver gate:** no offer journey may flip to stored `profile` rendering before drovr deploys equal-version newest-`occurredAt` offer folding (ties keep the held offer). The existing strictly-newer rule ignores the second coupon at the same version. Current coupons remain live.
- The restater has `100 × 4/20 = 20 events/min`, or `20 × 60 × 24 × 30 = 864,000` one-event confirmations per 30 days before retries. Its conservative admission ceiling preserves four-ninths utilization: `min(400, floor(20 × 15 × 4/9)) = 133 contacts/tick`, hence **`133 × 2,880 = 383,040 contacts/30 days`**. The remainder is retry/catch-up headroom, not borrowed live capacity. No production population is published here.
- A capacity overflow emits `drovr.restate.capacity_exceeded` with population/capacity counts, then terminally fails in Inngest. It is an **alert visible in logs and Inngest failures**, not a page. Follow-up: **route the capacity alert to a pager**.
- Deploy/rollback inventory covers all new priority workers, the restater, producer commands and pending outbox rows. Old code cannot consume every new envelope and does **not** preserve the cap. Follow `drovr-bulk-births-runbook.md`; drain or save/cancel/re-issue rather than pausing functions.

## Historical unsubscribes after a resubscribe

Drovr confirmation `3mxwwjnmt7iq6` (relayed in `3mxwwjynxrt6i`) is deliberately stricter than assuming every receiver is time-safe: v1/v2 directory actors and course journeys stop on arrival. AIH therefore closes an unsubscribe superseded by a **strictly newer resubscribe**, using `activeContactStops` whole-second comparisons, instead of posting it late. A timestamp tie keeps the stop. **Bounce and complaint always apply and are never lifted or closed by a resubscribe.**

Both single/batch transports and outbox gate hydration enforce this. A closed row retains its original body and `status = 'superseded'`, with source-cited typed `unsubscribeSupersession` state in `heldContinuation`; `lastError` is opaque operator prose, never the closure proof. It is not counted as HTTP acceptance or an outage. Already-delivered history is never rewritten. Replay skips a due snapshot closed during gate hydration, even if its old attempt count would otherwise escalate it.

The retained lift boundary permits work planned at/after that lift, but does not restart pre-lift work. Do not convert these rows to delivered or delete their permission evidence merely to unblock old work. The latest resubscribe boundary is refreshed through the same canonical rule. This local historical check is **not** a claim of atomic ordering between an already in-flight HTTP request and a concurrent resubscribe; retain the documented straggler and legacy-writer safeguards.

Read-only audit, with no customer values embedded in this example:

```sql
SELECT id, status, eventType, lastError
FROM AI_DrovrOutbox
WHERE target = 'production' AND status = 'superseded'
  AND eventType = 'contact.unsubscribed'
ORDER BY createdAt DESC LIMIT 100;
```

## What to watch

- `drovr.outbox.depth` every 5 minutes: `pending`, `held`, `rejected`, `oldestPendingAgeMin`, `oldestOpenStopAgeMin`, `oldestDeferredStopAgeMin`, `heldStops`, `oldestHeldStopAgeMin`.
- **Held stops** (row 204c) have their own lines on every replay run, which drovr's Axiom monitors count:
  - `drovr.outbox.stop_held_standing` (warn) while any stop is held. The monitor `aihero-drovr-outbox-held-stop` emails.
  - `drovr.outbox.stop_held_overdue` (error) once the oldest held stop is more than 24 hours old, by `firstFailedAt`. The monitor `aihero-drovr-outbox-held-stop-overdue` pages. The clock starts at the stop's first failure, not when it was held, so a stop that waited in the outbox (a deferred backfill stop) and is then refused can page on the next run.
  - the 10-minute agent check picks up the warning, and a stop still held after 30 minutes becomes a desk item for Joel.
- `drovr.outbox.alert` with `reasons`. It fires on every run until the cause is gone; the Axiom monitor `aihero-drovr-outbox` counts it:
  - `pending`: more than 25 rows waiting;
  - `oldest`: a row waiting for more than 60 minutes;
  - `held`: a birth newly held, or a stop newly held (drovr refused it with a 4xx, row 204c);
  - `rejected`: a fact or birth drovr refused on replay;
  - `stop`: a stop (unsubscribe, bounce, complaint, purchase) still owed after 10 minutes, pending or rejected. A held stop gates its facts but pages only through its own monitor. A stop the contact-sync straggler retry owns (source `contactSync`) waits a day by design, so it counts here only after 48 hours.
    - A stop is captured on its first live failure, so this also fires while Inngest is still retrying it: drovr has refused it for 10 minutes. If a retry then lands, the row is settled and the alert clears on the next run with nothing to do.

## The gates

- **A birth** (`contact.created`, or a signup) that is pending or held holds that contact's rows on its journey; a signup holds every row of the contact.
- **A stop** that is pending, held or rejected holds every row of its contact that happened at or after it, on any journey. Its facts wait an hour at a time until a human acts.
- **One rule decides drovr's answer to a stop** (row 204c, `drovrStopVerdict` in `drovr-stop-verdict.ts`). The single post, a whole batch, a batch item, the straggler retry and the replay all call it, and `drovr-stop-verdict.test.ts` pins each answer on each path.
  - **Landed:** a 2xx, or a directory stop's 409 `cold-start-unhandled` (drovr writes the suppression row first, mig-10).
  - **Released, nothing owed:** an owner copy drovr answers `contact-never-born`, for every stop kind, a purchase included. The contact was never on that journey. The directory stop itself is never released this way.
  - **Pending, retried:** a 5xx, a timeout or network error, 408, 429 and 409 `event-not-live`, and nothing else. It still gates.
  - **Held for a human:** every other 4xx, including 409 `cold-start-unhandled` on any stop but a directory one (drovr says not to retry it; the hawk, 2026-09-30). Nothing releases it but a human (below). Failing closed costs a missed pitch; failing open can pitch a buyer or someone who unsubscribed.
  - **Answers are read by their code only** (`drovrProblemCodes`): a problem's `type` slug and `code`; a batch item's detail as the actor's JSON `code`, or the text before the first colon in drovr's `event-not-live: <reason>` form. Never a title, detail, hint or error text, so a key or message that names another code picks no rule (201g-f2).
  - The one exception is a whole-batch 404 or 405. That means drovr has no batch ingress, not an answer about the events, so the chunk retries and the replay later posts the stop alone. The gate is closed throughout.
  - Facts and births keep their own rules: a fact's 4xx other than `event-not-live` is rejected.
  - The dispatch fallback (a direct post when Inngest is unreachable) outboxes a refused stop as pending. The replay's re-post then holds it within 5 minutes.
- **A backfill stop drovr answers `event-not-live`** goes to the contact-sync straggler retry, and is also outboxed (pending, source `contactSync`, due in 24 hours) so it gates its contact while it waits. The straggler retry settles it when drovr takes it, or holds it if drovr refuses it. After a day the replay posts it too; drovr dedupes by key.
- **A birth never waits behind a stop that is itself waiting for a birth.** drovr takes no stop for a contact it never saw born, so the birth goes first and the stop right after it, in the same run. That is what keeps the two gates from deadlocking.
- **A stop is captured on its first live failure**, not after Inngest's retries. Its row is pending with a `nextAttemptAt` about 79 minutes out (the rest of the retry ladder). The replay leaves it alone until then, but it gates at once. A retry that lands marks it delivered (`drovr.outbox.settled_by_retry`), and makes the contact's facts that waited behind a stop (their `lastError` says so) due again, so they post on the next run instead of at the window's end. The contact's other stops keep their windows, and so does a fact waiting out its own Retry-After.
  - The window counts this attempt's Retry-After and the backoff table after it. If drovr sends long Retry-After hints on later attempts too, Inngest's retries can run past the window by up to the sum of those hints. The replay may then post the stop while a retry does too, and drovr dedupes the second post by its idempotency key.
- **Live delivery reads this table once per batch** (the stop gate, on `DrovrOutbox_contact_idx`). A failed read retries; on the last attempt the whole batch goes to the outbox, never posted unchecked. If the database is down past the retry ladder, the capture fails too: the events are then only in the logs (`drovr.outbox.capture_failed`, with their keys).

## Held logical batches and replay proof: apply-first control column

`20261016_ai_hero_drovr_held_continuation.sql` adds exactly one nullable
`AI_DrovrOutbox.heldContinuation JSON` column. **Apply first** through the
operator's PlanetScale deploy request, before merging/enabling the new writers.
The desk reports DR 48 deployed with `JSON NULL` readback. That operator receipt
is not a substitute for this revision's disposable-MySQL/controller tests.

The column has a versioned Effect Schema envelope with five independently
versioned members: `continuation`, `replayProof`, `ownerStopRejection`,
`unsubscribeSupersession`, and `profileAck`. The whole encoded envelope is
bounded at **256 KiB UTF-8**, while a logical continuation remains bounded at
**128 scoped references / 48 KiB**. A frozen profile ACK request has a separate
**1,024-reference ceiling**, still subject to that same 256 KiB envelope bound.
It stores no event bodies or rebased clocks. Overflow and invalid state refuse
with a literal-prompt error; nothing is trimmed. `lastError` remains operator
prose only, never a control-state fallback.

The one whole-subsystem app/admin flag is **`drovr-profile-ack-enabled`**, default **OFF in all four environments**. Fresh bounded Redis reads fail OFF on missing values, errors or timeouts. It gates registration, completion and failed/partial-ACK tombstones together, never genuine signup/purchase/unsubscribe delivery. This PR changes no stored flag value. OFF keeps main's legacy optimistic producer ACK to prevent additional sends/re-captures; it does not write new coordinators/tombstones, pin ACK receipts or reconstruct purged history. The source-pinned main fixture checks every prefix, including a conservative downstream offer-repair allowance; this is a local model, not a deployed POST measurement.

Tombstones have their own `ackTombstone` status/source, `control` endpoint, Schema-decoded fixed `{"control":"ackTombstone","v":1}` NOT NULL body and first-created +400-day/version-change expiry. They are not native events or positive/negative receipts. Native due/retry/held/operator/depth queries and generic writes explicitly exclude them; attempted capture, replay POST or broker publication literally refuses before any port is touched. Ordinary delivered-row purge cannot delete a live tombstone. While ON, purge of incomplete coordinator evidence inserts/fences its tombstone **before DELETE in the same transaction**. Disposable MySQL tests cover rollback after insertion and after deletion, plus committed marker-before-delete ordering. Dedicated 400-day/version-change tombstone deletion and producer/worker registration plumbing remain WIP; this is not permission to enable. Enabling is a **one-way reader-first boundary**, not a flag-off or old-code rollback: prove all active readers compatible and drain/save/cancel deliberately before changing an in-flight rollout.

### `PurgeRefused`: known new metadata while the flag is OFF/unknown

An OFF/missing/error flag read encountering incomplete existing `profileAck` evidence returns Schema-typed **`PurgeRefused`**, reason **`profile-ack-protection-flag-off`**. It deletes **nothing in that entire tick**, including unrelated eligible receipts. It creates no tombstone, per-reference ACK pin or new control state. A never-ON fixture retains ordinary main purge behavior. The next **scheduled** tick re-reads the flag; never hot-loop or parse the literal prompt to authorize deletion.

The scheduler emits one structured error signal **`drovr.outbox.purge_refused`** per refused tick, with only `protectedRows`, `candidateRows` and the literal prompt. Drovr/Shaman should alert when this signal persists **more than 24 hours**; alert routing is not an exactly-once/pager guarantee. This is the **one-way reader boundary**: old code or a disabled writer cannot silently discard already-created new-protocol evidence.

Operator recovery:
1. Inspect flag service health and reader deployment compatibility. With explicit operator approval, restore/re-enable `drovr-profile-ack-enabled`; the next scheduled purge writes the required terminal marker atomically and resumes. Do not issue a production flag write merely from this runbook.
2. Or explicitly drain: save/inspect the original SDK ownership, cancel competing jobs, restore the gate under approval and finish only actually accepted retained native work. Complete original proof atomically; then a subsequent OFF purge can remove the ordinary receipts without a new tombstone. Missing proof remains terminal `AckEvidenceExpired`; native debt is still owed. Never simulate a drain by trimming JSON, fabricating delivery, refreshing clocks or reconstructing history.
3. Do not drop the column, roll old readers back over new state, or repeatedly release work to bypass this refusal. Escalate the count-only >24h signal to the desk.

**WIP boundary:** the fifth-member codec, pure proof/clock policy and atomic native-settlement/first-proof helper are tested
locally; immutable capture/registration and automatic SDK-worker plumbing are
not yet complete. This checkpoint is not merge/deploy ready. Profile ACK covers
only frozen profile/link membership, not the separately durable current-offer
repair. `confirmationClock` is the delivered profile's frozen `occurredAt` and
is the only confirmation-age input, forward only. `provedAt` is complete-receipt
proof time for audit only. Identical same-request proof is a no-op; different
proof refuses. A different explicit monthly period is a different request.
Missing purged evidence returns terminal `AckEvidenceExpired` without a new pin,
recapture, timestamp refresh or ACK retry; this does not abandon retained native
debt. The worker-level no-retry/log-once execution proof remains outstanding.

- Ordinary missing-column readers log once and mean no held state. Coordination
  and ACK readers/writers refuse without a diagnostic or legacy fallback, even
  when a later proof chunk is the first read to encounter the missing column.
  Apply the migration rather than repeatedly releasing such work.
- Only delivered rows referenced by an **unfinished held/released coordinator**
  are pinned. All unreferenced receipts retain the existing seven-day purge.
  Terminal logical completion records a marker and ends the pin, so the next
  normal purge may delete an otherwise eligible receipt.
- At 30 days after the **first parking time**, diagnostics expose `pin-expired`.
  Expiry never silently deletes evidence, rebases the hold, or auto-releases it.
  An operator must explicitly release or abandon/complete it. Abandoning the
  logical coordinator does not retire a native stop/birth or fabricate delivery.
- Release requires the exact inspected state and checking/cancelling existing
  SDK work. It grants one new permission, not a new body/version. Actual ACK
  requires fresh whole-membership dispositions and the matching stored profile
  authority; an accepted link/offer cannot stand in for an unaccepted profile.
  Rejected members suppress ACK. Completion follows actual ACK/refresh obligations.
- Do **not** use the legacy `lastError` release/retirement SQL below on rows with
  operational state. The bounded diagnostic/release services are
  `inspectHeldBatchesLive`, `releaseHeldBatchLive`, and `abandonHeldBatchLive`;
  the operator CLI and its execution proof must land before this PR is ready.

**Stateful rollback:** this is a durable compatibility boundary. Dropping the
column loses held/pin/completion **and replay handoff/claim state**, not wire
bodies, original clocks or HTTP history. Drain, save, cancel and deliberately
reissue affected SDK work before rolling back. Old code cannot safely interpret
or automatically resume these permissions; there is no cap-preserving old-code
rollback or whole-system exactly-once guarantee.

Named post-wave follow-up: **Held Control V2 — Indexed Reference and Lifecycle
Fields**. Replace bounded JSON coordinator scans with reviewed indexed lifecycle
and scoped-reference storage, including completion/retention and operator audit.
That is a separate schema decision, not permission for another column/table here.

## What a row is holding back (read-only)

```sql
SELECT id, eventType, journeyId, status, occurredAt, nextAttemptAt, lastStatus, lastError
FROM AI_DrovrOutbox
WHERE target = 'production' AND contactId = ? AND status IN ('pending', 'deferred', 'held', 'rejected')
ORDER BY occurredAt;
```

## A held stop: decide, then re-send or retire (audited)

1. Read why drovr refused it: `lastStatus` and `lastError` hold the status and drovr's problem.
   - A 401 or 403 is a key or tenant problem.
   - A 404 `unknown-route` means a wrong or unset `DROVR_SHADOW_INGEST_URL`.
   - A 404 `unknown-journey` is a journey that isn't live yet.
   - A 400 `malformed-event` is an ai-hero bug.
   - A 410 `tenant-retired` is a drovr decision.
   - A 409 `idempotency-key-holds-another-event` (drovr #635) means drovr already holds a different event type under this key, so nothing was recorded. It's an ai-hero key bug. Re-sending the same key is refused again, so fix the key and re-issue the stop under a new one. A fact that meets it is refused and logged at `drovr.outbox.rejected`.
   - A 409 `cold-start-unhandled` means the contact has no actor on that journey, and the stop does not start one. Find out why the contact isn't there (a missing birth, or a journey the contact was never on) before re-sending.
2. Fix the cause first, then **re-send** it with the statement under "Release a held or rejected row". Put who and why in `lastError`, as that statement does.
3. **Retire** it only when the stop is truly moot (see "Retire a row"). A purchase is never retired.
4. Post the row ids, the decision and the reason to the desk as a `done` item: that is the audit trail. Delivered rows are purged after 7 days.

## A birth held over 24 hours: check drovr first (row 201g)

A released row posts its first send's bytes, so a birth released after a long hold is backdated by the hold. An evergreen start backdated by days fires every passed slot at the next due check and shortens the offer window. So before releasing a held birth (`contact.created`, or the evergreen `course.sequence-exhausted`):
1. **Ask whether drovr FOLDED the birth, not whether it logged it.** Read the actor: `GET /contacts?contact=<contactId>&journey=<journeyId>` (MCP `get_contact`). On these journeys only the birth creates the actor, so an actor means the birth folded, and `404 contact-not-found` means it didn't.
   - **Don't decide from the trace's facts.** They are rows of drovr's event log (`contact-trace.ts`), not folds. A birth whose append landed but whose forward failed is in the log with no actor. Releasing it would forward the first send's bytes and birth the contact backdated by the whole hold, which is the harm this check prevents.
   - The trace is still useful to see what happened. Pass `since` at least an hour before the row's `occurredAt`: facts are filtered on `occurredAt`, and the default window is the last 24 hours (`DEFAULT_SINCE_MS`, 31 days at most). An answer from the default window means nothing.
2. **Folded (an actor on the journey):** release it as below. That's a no-op, since drovr keeps the first write, and it lifts the gate on the rows behind it.
3. **Not folded (404), even if the key is in the log:** don't release it. Re-issue it as a **new** event: a new idempotency key (the old one plus `:reissued:<UTC date>`), clamped at the re-issue. Close the old row as superseded (see "Retire a row", with `lastError` = `superseded by <new key>`), and post both to the desk.
   - No tool mints the re-issue yet (it's follow-up row 201g-f1). Don't hand-write one: the row's `dedupeKey` is a sha256 of a JSON array. Until the tool exists, ask the owner.

## Release a held or rejected row

It posts at the next run; drovr dedupes by key if it already has it.

```sql
UPDATE AI_DrovrOutbox SET status = 'pending', releasedAt = NOW(3), nextAttemptAt = NOW(3),
  lastError = LEFT(CONCAT('released by <name> <ISO time>: <why>; was: ', COALESCE(lastError, '')), 1000)
WHERE status IN ('held', 'rejected') AND heldContinuation IS NULL AND id IN (…);
```

`lastError` is `varchar(1000)`, and a refusal already fills it, so the `LEFT` keeps the update from failing (MySQL error 1406). Double any `'` in `<why>`.

Then send `drovr/outbox.replay-requested`, or wait for the next :x2/:x7 tick. A row drovr refuses for good is refused again, so release alone won't end the hold: read `lastError` first.

## Retire a row (it never posts)

Its gate lifts and the rows behind it post at the next run. Delivered rows are purged after 7 days, so record the retirement in the row log too.

**A purchase is never retired. Profile/link/offer rows must not be retired as delivered either:** that would manufacture ACK evidence, not prove receiver acceptance. The legacy SQL below excludes all four kinds and applies only to control-free legacy rows; it is never a new `profileAck` completion mechanism. Retiring `purchase.recorded` means drovr never learns of the purchase, so the buyer is pitched P2–P5: nothing but drovr knowing stops that. This statement refuses one:

```sql
UPDATE AI_DrovrOutbox SET status = 'delivered', deliveredAt = NOW(3), lastError = 'retired by hand: <reason>'
WHERE status IN ('held', 'rejected') AND heldContinuation IS NULL
  AND eventType NOT IN ('purchase.recorded', 'contact.profile.updated', 'contact.links.issued', 'contact.offer.issued') AND id IN (…);
```

A purchase drovr keeps refusing is a drovr bug: fix it there, then release the row. The exception is drovr's `contact-never-born` on an owner copy, which is the correct answer and is released on its own; it is never held. Until then it stays held, its facts stay held, and the held-stop monitor pages after a day, which is right: the buyer must not be pitched.

- **Unsubscribe, bounce and complaint** are also refused at send time by Kit and by ai-hero's `contact-stop-rule`, so retiring one of those loses less. It still leaves drovr's own record wrong.
- **A retired birth** releases the rows behind it. A stop that waited for it then posts alone. If drovr answers never-born, an owner copy is released; a directory stop is held, since it is the suppression authority.

## Limits

- **Source `contactSync` is not always deferred:** the stop alert gives every pending `contactSync` stop 48 hours, including a straggler or profile-sync stop captured because drovr was down, which is due now. The `oldest` alert (60 minutes) still fires for it.
- **A stop deferred again on a bulk retry:** a stop first captured on a 5xx (source `bulk`), whose retry is then answered `event-not-live`, keeps its 10-minute `stop` alert. It gates correctly and the straggler retry settles it, but it can page for a while before that.

- Holding later facts stops new email that an overtaking fact would start. It can't stop timers drovr already scheduled; only delivering the stop does. Hence the `stop` alert.
- If Inngest runs a stop's retries later than its window (its own queueing, or later Retry-After hints), the replay may post the stop while a retry does too. drovr dedupes the second post by its idempotency key.
