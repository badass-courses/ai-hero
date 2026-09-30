# Bulk births into drovr (row 201g)

A **bulk birth** is any job that births more than 1,000 contacts into a drip or calendar journey: an import, a backfill, or a re-seed. drovr arms a journey's drips from the birth's `occurredAt`, so the spread of births over time is the spread of every drip wave after it.

## The rules

1. **Go through the paced lane.** For ai-hero, that lane is `drovr-events-deliver-bulk-v1`.
   - It is throttled to 7 runs a minute of up to 100 bulk events each: at most **700 events a minute**. Inngest counts run starts, and it spaces them evenly through the minute.
   - Its producers are `BULK_DELIVERY_SOURCES` in `src/inngest/events/drovr.ts`: the Kit directory ingest, the contact-sync backfill and the evergreen pitch backfill.
   - Never loop `POST /events` or `POST /events/batch` at full speed. Never push a bulk job through the live lane (`drovr-events-deliver-v1`).
   - Everything on the lane waits its turn, a directory stop from the Kit ingest or the contact-sync backfill included. Live stops (Kit webhooks, ai-hero unsubscribes) are on the live lane and never wait.
   - **The 700 a minute is not yet measured.** Inngest's batching guide doesn't list throttle as incompatible with `batchEvents`, but nothing proves it counts a batched run as one start. See "Before the first prod backfill" below.
   - Any other producer paces itself to **≤ 750 births a minute**, and to ≤ 1,000 a minute counting the live signups at the time. At that rate a 130k import takes about 3 hours.
2. **Pick the start time so the daily repeats miss the calendar waves.** A value-path cohort's drips repeat at the same clock time for 7 days.
   - The import window must not overlap 15:30–16:30Z (the evergreen calendar wave) or 17:45–18:15Z (the shadow-newsletter PT minute).
   - Don't run during a launch send, or inside 11-09 … 11-15.
3. **Calendar journeys don't spread by pacing.** Evergreen and the shadow newsletter send at local calendar instants, so births paced over hours on one day still fire together.
   - Keep **≤ 60k births per local slot per UTC offset** at a 90-minute spread window, and ≤ 20k while the window is 30 minutes. Split the job across days to stay under.
   - The shadow slot counts every `contact.created`.
4. **Canary first:** a real one-page run that WRITES: the contact-sync backfill's `maxPages: 1` (it stops and doesn't re-queue), or the evergreen backfill's `--apply --limit 25 --out <report.json>` (a per-run cap; the script refuses to start without `--out`). Without `--apply` the backfill is a dry run that posts nothing, and the checks below would pass without testing anything. Then check drovr, and resume only if all three hold:
   - zero `overload` log lines in Axiom since the canary started;
   - `GET /status` with STUCK green;
   - no hold you didn't expect.

   `/status` has no overload field (it reports flow, holds, served and stuck), so the overload check is the log line.
5. **Watch:** drovr's D1 query time per minute (the shed line is about 7.3 s a minute), `overload` log lines, and the queue vital. **At the first overload line, stop the producer:** the import or backfill script, or the Kit bulk action. Its cursor resumes where it stopped. What is already queued drains at ≤ 700 a minute.
   - A send that fails (a 5xx, 429 or timeout) retries, then outboxes. A stop drovr refuses with a 4xx is held for a human (row 204c; `drovr-outbox-runbook.md`).
   - **Never pause the Inngest function.** Inngest SKIPS events that arrive while a function is paused, and doesn't reprocess them unless someone runs a manual Replay (which ignores event idempotency). The producers' cursors have already moved past them, and the bulk lane carries directory stops.
   - If it was paused anyway, resume it, then Replay its "Skipped" runs for the paused window. Also Replay its "Canceled" runs if the pause cancelled them, or if it lasted more than 7 days.
   - To stop sends on one journey right now, `hold_journey` on drovr parks dispatch; nothing is lost.
6. **Don't backdate births into drip journeys.** ai-hero enforces this at the send (below). The directory seed backdates only the contact directory, which sends nothing. Check which journeys a job's events name.

## Before the first prod backfill: measure the lane

A gate, not code (Sonnet 2's review of #345). On dev or stage Inngest, send **at least 1,000** bulk events to `drovr-events-deliver-bulk-v1` in one burst, and count the run starts per minute.
- **Why 1,000:** at up to 100 events a run, that is 10 or more runs. So an unthrottled lane must start 8 or more in the first minute and fail. With 300 (3 runs), the gate could not fail.
- **Expected for 1,000:** about 10 run starts in all, **at most 7 in any minute**, with the starts falling **in at least 2 separate minutes** (7, then 3). Evenly spaced starts can put all 10 within about 80 seconds, so count minutes, not the span. Each run takes up to 100 events.
- **It counts only on a fast stage.** The bulk function's own `concurrency: 4` caps starts by itself: four runs at a time, each taking *d* seconds, start at most 4 × 60 / *d* a minute, which is 7 or fewer once runs take about 34 s. On a slow stage, the throttle-shaped result then shows up whether or not the throttle exists. So also read each run's duration: **the result counts only if the median run took ≤ 10 s** (then concurrency alone would allow 24 or more starts a minute). A slower median makes it **inconclusive**, not a pass: re-run it on a faster stage.
- **Pass:** all three hold: the median run took ≤ 10 s, at most 7 starts in every minute, and starts in at least 2 separate minutes.
- **Fail:** 8 or more starts in a minute. There's no pacing, and only the clamp is left. Don't run the backfill; tell the owner.

Record the result (the environment, the median run duration, the minute counts, the date) on the row before the prod run.

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
    - **Value-path (V2):** it sends email 0 at once, then paces normally: V2's 24 h wait counts from `email.completed`, not from the birth (drovr `journey-value-path` `waiting`). Once 201e PR A is live, its anchored drips are floored at 18 h.
    - **Evergreen:** every slot already passed fires at the next due check, and the offer window is shorter by the hold.
    - **The shadow newsletter:** a first Thursday already passed goes at the next due check.
  - **So check whether drovr FOLDED it before releasing one** (the hawk, `drovr-outbox-runbook.md`, "A birth held over 24 hours"). Read the actor with `GET /contacts?contact=&journey=` (`get_contact`).
    - **An actor on the journey:** the birth folded, so release it. drovr keeps the first write, so nothing changes.
    - **`404 contact-not-found`:** re-issue it as a new event with a fresh clamp, even if the key is in drovr's log. Don't release it: a logged-but-unfolded key would be forwarded and born backdated by the hold.
- **Its effect on a calendar journey:** a clamped shadow-newsletter birth can move its first eligible Thursday a week later, never earlier. A clamped evergreen start moves the offer's slots later by the clamp, never earlier. The offer's `completedAt` in the payload keeps the real completion.

## The evergreen pitch backfill

`src/scripts/evergreen-pitch-backfill.ts` births each contact at its own instant, read as it dispatches, and shares that instant between ai-hero's entry and drovr's birth. Its batches ride the bulk lane (source `evergreen-pitch-backfill`).
- It waits 100 ms between births, at most 600 a minute against the lane's 700. So a birth never queues behind the throttle long enough to be clamped off the instant ai-hero's entry recorded.
- That matters because ai-hero's offer deadline comes from its entry, and drovr's comes from the birth's `occurredAt`. A `drovr.birth.clamped` line with `path: batch` during a backfill means they have drifted apart: stop and look.
- **Run it alone.** The lane's 7 runs a minute are shared with the Kit directory ingest and the contact-sync backfill. With either running, the backfill's births can wait more than 5 minutes and be clamped off ai-hero's entry instant. Check that neither is running and that the lane's queue is empty first.
- `--limit` bounds a run. Split a large population across days so that no local slot passes the calendar cap.
- **A stop on the evergreen journey waits behind its contact's pending or held evergreen start** (the start is a birth). A held start therefore hides its stops from the held-stop monitor until it is released or retired.
