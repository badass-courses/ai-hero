# Bulk births into drovr (row 201g)

A **bulk birth** is any job that births more than 1,000 contacts into a drip or calendar journey: an import, a backfill, or a re-seed. drovr arms a journey's drips from the birth's `occurredAt`, so the spread of births over time is the spread of every drip wave after it.

## The rules

1. **Go through a capped worker, never the live queue.** Existing `drovr-events-deliver-bulk-v1` remains for manual births/backfill and old envelopes. Additive workers isolate `drovr-events-deliver-delta-v1`, `drovr-events-deliver-restate-v1` and `drovr-events-deliver-ingest-v1` so a backfill backlog cannot occupy the delta worker.
   - `BULK_EVENTS_PER_MINUTE` is the measured **100-event/sliding-minute ceiling** — **drovr report, observed 2026-10-15**. Every POST carries one event, smoothly paced rather than burst in minute buckets. The one `bulk-delivery-pace-v2` cursor row holds disjoint 600ms slot classes: delta **60/min**, restatement **20/min**, ingest **15/min**, backfill **5/min**. There is no borrowing; unused background or delta capacity stays unused. Bump offer refreshes retain their originating class. These are reserved budgets, not a claim that the queues are work-conserving.
   - Each reservation owns its database connection and row-lock transaction, sets and verifies session UTC, then returns a future slot. Inngest sleeps durably until it; no Node timer holds a Vercel step. Lookahead beyond ten minutes fails back with `RetryAfterError`. Every HTTP retry allocates a fresh slot under a new memoized step id; replay hands capped work back to its worker instead of sleeping in the replay step. Failed POSTs spend their slots. Reservations count events, not envelopes or owner fan-out. Actual POST-start timing still needs the isolated measurement below.
   - Producers are `BULK_DELIVERY_SOURCES` in `src/inngest/events/drovr.ts`. Genuine coupon completions and offer-only repairs, including their offer-only straggler retries, stay live and never reserve a slot. Profile-bump offer refreshes are different: after the profile lands, their isolated worker reads the current coupon and reserves the same class; it never republishes a captured old coupon snapshot.
   - Never loop `POST /events` or `POST /events/batch` at full speed. Never push a bulk job through the live lane (`drovr-events-deliver-v1`).
   - Everything on the lane waits its turn, a directory stop from the Kit ingest or the contact-sync backfill included. Live stops (Kit webhooks, ai-hero unsubscribes) are on the live lane and never wait.
   - The cap now follows drovr's measured report; this PR has not measured the deployed scheduler. Do not raise the constant without another receiver report and review. Keep only one bulk producer active when checking timing-sensitive births.
2. **Pick the start time so the daily repeats miss the calendar waves.** A value-path cohort's drips repeat at the same clock time for 7 days.
   - The import window must not overlap 15:30–16:30Z (the evergreen calendar wave) or 17:45–18:15Z (the shadow-newsletter PT minute).
   - Don't run during a launch send, or inside 11-09 … 11-15.
3. **Calendar journeys don't spread by pacing.** Evergreen and the shadow newsletter send at local calendar instants, so births paced over hours on one day still fire together.
   - Keep **≤ 60k births per local slot per UTC offset** at a 90-minute spread window, and ≤ 20k while the window is 30 minutes. Split the job across days to stay under.
   - The shadow slot counts every `contact.created`.
4. **Dungeon: count, one contact, then a manually approved batch.** The contact-sync backfill has no cron and never schedules its own continuation. Send `drovr/contact-sync.backfill-requested` with `{ "dryRun": true }` first. That performs one aggregate `COUNT(*)` per source phase, without paginated row reads, snapshots, anchors, version writes or event publication. Then omit the cursor and send `{ "canary": true, "dryRunCount": <count from receipt> }`. The code forces one contact and one page, regardless of a requested page size. A command without those approval fields refuses with `BackfillCanary:`. A count is source rows, not distinct contacts.
   - The canary rechecks the count and must queue exactly one eligible contact. Save its receipt, including its cursor and `approvalToken`. After checking drovr, explicitly send that exact cursor with `canary: true`, the same `dryRunCount`, `canaryConfirmed: true`, its token, and a bounded `maxPages`. Each receipt grants one persisted, single-use, 24-hour token bound to the count and complete next cursor. Wrong count/cursor, missing confirmation, expired or reused tokens refuse terminally. No slice continues itself. The token proves command provenance, not that an operator inspected drovr. A failed slice must resume its existing durable run; a new command cannot reuse its consumed token.
   - The evergreen backfill remains a separate manual birth tool. Count without applying, then use a one-contact apply with a report before approving another bounded slice.
   - After the real canary, resume only if all three hold:
   - zero `overload` log lines in Axiom since the canary started;
   - `GET /status` with STUCK green;
   - no hold you didn't expect.

   `/status` has no overload field (it reports flow, holds, served and stuck), so the overload check is the log line.
5. **Watch:** drovr's D1 query time per minute (the shed line is about 7.3 s a minute), `overload` log lines, and the queue vital. **At the first overload line, stop the producer:** the import or backfill script, or the Kit bulk action. Its cursor resumes where it stopped. What is already queued drains through the shared cap.
   - A send that fails (a 5xx, 429 or timeout) retries, then outboxes. A stop drovr refuses with a 4xx is held for a human (row 204c; `drovr-outbox-runbook.md`).
   - **Never pause the Inngest function.** Inngest SKIPS events that arrive while a function is paused, and doesn't reprocess them unless someone runs a manual Replay (which ignores event idempotency). The producers' cursors have already moved past them, and the bulk lane carries directory stops.
   - If it was paused anyway, resume it, then Replay its "Skipped" runs for the paused window. Also Replay its "Canceled" runs if the pause cancelled them, or if it lasted more than 7 days.
   - To stop sends on one journey right now, `hold_journey` on drovr parks dispatch; nothing is lost.
6. **Don't backdate births into drip journeys.** ai-hero enforces this at the send (below). The directory seed backdates only the contact directory, which sends nothing. Check which journeys a job's events name.

## Before deploy: inventory and drain

The operator runs this read-only inventory. Do not infer an empty queue from one page of event history.

1. In the Inngest dashboard, open Runs for `drovr-contact-sync-backfill-v1`, `drovr-events-deliver-bulk-v1`, `drovr-events-deliver-delta-v1`, `drovr-events-deliver-restate-v1`, `drovr-events-deliver-ingest-v1`, `drovr-contact-sync-restate-v1`, `drovr-outbox-replay-v1`, `drovr-contact-sync-retry-v1`, `drovr-contact-sync-reconcile-v1` and `drovr-contact-profile-sync-v1`. Some additive workers do not exist before the first deploy. Filter each to Running or Queued. Record count, oldest start, triggering data and last completed cursor/step. Also inventory pending/held/rejected outbox rows by source/class and their oldest age; queued Inngest runs are not the entire durable backlog. In particular identify old materialized offer payloads before enabling the new offer fold.
2. Read trigger data with REST v1. Use a time before the oldest pending command, and inspect every response page. These are GETs only; substitute the environment's signing key without saving it in a receipt:

   ```sh
   curl --fail-with-body --silent --show-error --get \
     'https://api.inngest.com/v1/events' \
     --data-urlencode 'name=drovr/contact-sync.backfill-requested' \
     --data-urlencode 'received_after=<ISO>' \
     --header 'Authorization: Bearer <environment signing key>'

   curl --fail-with-body --silent --show-error \
     'https://api.inngest.com/v1/events/<eventId>/runs' \
     --header 'Authorization: Bearer <environment signing key>'
   ```

   Repeat the event lookup for `drovr/events.deliver.bulk`, `drovr/events.deliver.delta`, `drovr/events.deliver.restate`, `drovr/events.deliver.ingest`, `drovr/contact-sync.retry-requested` and `drovr/outbox.replay-requested`. Cron runs are inventoried in the dashboard. Keep raw payloads in the private operator receipt, not this repository.
3. If any listed run is Running or Queued, **do not deploy yet**. Let it drain on the old code, or explicitly approve cancellation, save its payload/cursor, deploy and re-issue it. Do not pause a function. Changed chunk sizes can exceed an in-flight run's step budget. Changed step ids can repeat a completed chunk under its immutable keys, which drovr dedupes. Profile-sync selection, delivery and acknowledgement steps have a new namespace so an old memoized result cannot acknowledge an unqueued new version.

**Replace a refused old backfill command:** save its original cursor for audit, count with `dryRun: true`, apply a cursor-free one-contact canary with `canary: true` and the matching count, inspect drovr, then continue from the **new receipt's cursor** with its bound token, explicit confirmation and bounded `maxPages`. An old arbitrary cursor cannot borrow a token for another cursor. This may restart the ordered walk; existing event keys stay idempotent, and matching legacy hashes migrate without spending a version. There is no arbitrary-cursor authorization tool in this PR. Carry `stopBeforePhase` forward explicitly. Missing approval refuses instead of silently authorizing an old command. No slice schedules its successor.

**Named migration notes:** no existing function id/trigger is removed; the three priority workers and restater are additive. Self-continuation is removed. Link keys lose the issue timestamp; retries retain captured old bytes/keys. Recompute the exact legacy combined hash: a match rewrites only the digest format at the same version, preserving its stamp and emitting nothing on a live sync; a mismatch takes the paced real-change path. No equal-version confirmation carries ambiguous changed values. Unacknowledged versions require the complete profile/link delivery, not a profile-only restatement. Backfill captures its complete page before publish/acknowledgement, so its new versions become eligible for later confirmations too.

The new JSON pace row and `backfill-approval:` receipts reuse the existing cursor table; no DDL is introduced. The old `bulk-delivery-pace-v1` row is not reinterpreted. Rollback to the old deploy loses the new cap and all additive consumers. Drain or save/cancel the restater, all three priority-worker queues, their `offerRefresh` commands, pending `reason: restate` commands and new backfill commands first. Old code may skip or never consume those commands. Compatible old bulk envelopes/outbox bodies still exist, but compatibility is **not** a cap-preserving rollback. Do not route new envelopes into old live code as a shortcut. Keep journey rendering live during the rollback and reconcile from saved receipts after reinstalling the new workers.

**Receiver dependency:** do not flip any offer journey to stored `profile` rendering until drovr deploys equal-version offers as newest-`occurredAt` wins, with ties retaining the held offer. The current strict-newer-version rule ignores a second coupon at the same version; current coupons remain live. Re-issued offers use the coupon's issue timestamp, not the profile's version timestamp.

**Restater capacity at the measured cap:** its 4 of 20 reserved slots give `100 × 4/20 = 20 events/min`. The wire ceiling is `20 × 60 × 24 × 30 = 864,000` one-event confirmations per 30 days **before retries**. Preserve the prior design's four-ninths utilization/headroom: `min(400, floor(20 × 15 × 4/9)) = 133 contacts/tick`. The admitted monthly population is therefore **`133 × (30 × 24 × 4) = 383,040 contacts per 30 days`**, not the larger wire ceiling. The remainder is retry/catch-up headroom; no live slack borrowing is implemented. These are capacity formulas, not production counts. If the private population ever exceeds this admission ceiling, the operator must review the share/quota before a batch.

**Capacity alert:** a monthly quota above 133 contacts/tick emits `drovr.restate.capacity_exceeded` with population, contacts-per-tick and monthly-capacity counts, then fails with `NonRetriableError`. This is an **alert visible in logs and Inngest failures**, not a configured page. Follow-up: **route the capacity alert to a pager**. Do not raise the quota/cap to make a red run disappear; review population, step count and receiver capacity.

## Before the first approved batch: measure actual sends

On an isolated non-production environment with synthetic events, exercise multiple envelopes, nested payloads, owner fan-out, retries and outbox replay together. Measure actual POST starts, not function starts. Every POST must carry one event, starts must be spaced by the shared slot interval, and every sliding minute must stay at or below the named cap. Saturate bulk while issuing a live synthetic coupon completion and verify it never requests a bulk reservation. The code/tests do not constitute a deployed scheduler measurement. Save the environment, event shape, timestamps and result privately before authorizing a real batch.

## No bulk value-path births in the 201e window

**From 201e PR A's deploy (10-18 at the latest) until PR B's deploy (the spread window W raised, at least 7 days later), no bulk value-path births.** At W = 30 with anchored drips, every wave is concentrated (the hawk, 201e S2 guard 1).
- The bulk lane enforces it (`drovr-bulk-freeze.ts`). Inside the window, it drops every value-path `contact.created` from a bulk run, logs `drovr.bulk.value_path_births_refused` at error with the count and up to 20 keys, and counts `valuePathBirthsRefused` in the run's receipt. The rest of the run is delivered.
- The window opens at `DROVR_VALUE_PATH_BULK_FREEZE.from`, 2026-10-18 00:00Z. If PR A deploys earlier, set `AIH_DROVR_VALUE_PATH_BULK_FREEZE=on` on prod first, before its deploy.
- PR B closes it by setting `DROVR_VALUE_PATH_BULK_FREEZE.until` to its deploy instant. Until then the window stays open, so the guard fails closed.
- **A value-path import inside the window needs the hawk's sign-off.** Set `AIH_DROVR_VALUE_PATH_BULK_SIGNOFF` to the hawk's name and the date, run the import, then unset it. Each run it lets through logs `drovr.bulk.value_path_births_signed_off` with who signed.
  - **The sign-off is lane-wide:** while it's set, every bulk run admits its value-path births. So run ONE value-path import at a time, with every other bulk producer stopped and the lane's queue empty before you set it.
  - **Unset it only after the lane drains.** Each run decides the freeze when it starts, so runs still queued behind the throttle when you unset it drop their value-path births. Wait until the import's runs have all finished and the queue is empty.
  - Vercel applies an env change at the next deploy, so redeploy after setting it and after unsetting it.
- A refused birth is not outboxed. Re-run the import after the window, or with the sign-off.

## The clamp at the send

Every event leaves ai-hero through `deliverDrovrShadowEvent` (the single post, the replay and the fallback) or `deliverBatchOrThrow` (the bulk lane and the straggler retry). Both clamp a **sending-journey birth** to at most 5 minutes before the send:
- **A sending-journey birth** is a `contact.created` anywhere but `contact-directory`: value-path, the shadow newsletter, an owner copy. The evergreen offer's `course.sequence-exhausted` counts too.
- **Untouched:** directory births keep the contact's `createdAt`, and stops and facts keep their own time, because the time is the fact.
- **The key never changes, and neither do the bytes.** Each event's clamp instant is fixed at its first send, and every retry and replay reuses it (the hawk, #345 S1). So a birth is at most 5 minutes old at its **first** send: a retry or a replay hours later posts those same bytes, hours old.
  - This matters because drovr's log keeps the first write of a key, but `deliverEvent` forwards the request's own event to the actor even when the append was a duplicate. A retry clamped to a later instant, after an ambiguous first post, would fold an `occurredAt` the log doesn't hold. drovr row 209 will make it forward the stored event instead.
  - **The Inngest lanes:** one memoized step per run (`drovr-birth-clamp-instant`), taken only when the run carries a sending-journey birth.
  - **The dispatch fallback's direct post:** one instant before it posts.
  - **The owner-birth guard is the one exception until drovr row 209.** It re-posts a birth drovr never folded, clamped at its own hourly run's memoized start, not at the first send. So if the first send's append landed but its forward didn't, drovr folds the guard's instant while its log keeps the first. The guard posts each owner once; row 209 (drovr folds the stored event on a duplicate) removes the difference.
  - **Within one run, a birth can be up to the run's retry span old.** The live lane sends one step per event, so a birth whose step runs after an earlier event's retries goes out dated up to that span before its send (Macroscope 4141816662). It's a handful of births per run, bounded by one retry schedule, not a wave; a per-event instant would cost one step per birth.
  - **The one gap:** the live function's `onFailure` backstop (a run that died before its own steps could outbox) captures its batch without the run's instant. Those rows are clamped at capture, so a birth that had already posted in that run replays with different bytes. This is narrow, and drovr row 209 removes the consequence.
  - **The outbox:** an event captured after a failed send keeps that send's instant as its row's `firstFailedAt`, and the replay clamps at `firstFailedAt`. A row never sent (held behind a stop, or an owner read that failed) is clamped at its capture, the same on every replay. So the 24 h hold is counted from the first send.
- **Every clamp is logged:** `drovr.birth.clamped` carries `path`, `count`, `maxLagSeconds`, and each birth's `lagSeconds` and `journeyIds` (in the same order). A burst of these lines with large lags is an outage backlog, or a backfill queued behind the throttle.
  - **Logged per attempt:** a retried send logs its line again with the same lags. So summing `count` over-counts under retries; read it as sends, not births.
- **It composes with the outbox.** A birth that has failed for more than 24 hours is held for a human, never sent (`drovr-outbox-runbook.md`).
  - **A released held birth posts its first send's bytes,** so it is backdated by its hold time. On each journey:
    - **Value-path (V2):** it sends email 0 at once, then paces normally: V2's 24 h wait counts from `email.completed`, not from the birth (drovr `journey-value-path` `waiting`). v7 to v9 (201e PR A, drovr #636, merged 2026-09-30) anchor the drips: each is due at `max(dripCompletedAt + 18 h, anchor + 24 h)`, where `dripCompletedAt` is the previous email's completion and the anchor is the `occurredAt` of the event that entered that email's step (the birth, for email 0). So a backdated birth still waits at least 18 h after each completion.
    - **Evergreen:** every slot already passed fires at the next due check, and the offer window is shorter by the hold.
    - **The shadow newsletter:** a first Thursday already passed goes at the next due check.
  - **So check whether drovr FOLDED it before releasing one** (the hawk, `drovr-outbox-runbook.md`, "A birth held over 24 hours"). Read the actor with `GET /contacts?contact=&journey=` (`get_contact`).
    - **An actor on the journey:** the birth folded, so release it. drovr keeps the first write, so nothing changes.
    - **`404 contact-not-found`:** re-issue it as a new event with a fresh clamp, even if the key is in drovr's log. Don't release it: a logged-but-unfolded key would be forwarded and born backdated by the hold.
- **Its effect on a calendar journey:** a clamped shadow-newsletter birth can move its first eligible Thursday a week later, never earlier. A clamped evergreen start moves the offer's slots later by the clamp, never earlier. The offer's `completedAt` in the payload keeps the real completion.

## The evergreen pitch backfill

`src/scripts/evergreen-pitch-backfill.ts` births each contact at its own instant, read as it dispatches, and shares that instant between ai-hero's entry and drovr's birth. Its batches ride the bulk lane (source `evergreen-pitch-backfill`).
- Its producer delay is not the delivery cap. The shared paced lane may queue a birth; do not assume the recorded entry instant and drovr's eventual first-send clamp stay aligned.
- That matters because ai-hero's offer deadline comes from its entry, and drovr's comes from the birth's `occurredAt`. A `drovr.birth.clamped` line with `path: batch` during a backfill means they have drifted apart: stop and look.
- **Run it alone.** The cap is shared with directory ingest, contact deltas, confirmations, retries and replay. Other producers can delay births until their first-send clamp shifts. Check the queue before the canary and throughout each bounded slice.
- `--limit` bounds a run. Split a large population across days so that no local slot passes the calendar cap.
- **A stop on the evergreen journey waits behind its contact's pending or held evergreen start** (the start is a birth). A held start therefore hides its stops from the held-stop monitor until it is released or retired.
