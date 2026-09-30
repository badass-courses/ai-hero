# Bulk births into drovr (row 201g)

A **bulk birth** is any job that births more than 1,000 contacts into a drip or calendar journey: an import, a backfill, or a re-seed. drovr arms a journey's drips from the birth's `occurredAt`, so the spread of births over time is the spread of every drip wave after it.

## The rules

1. **Go through the paced lane.** For ai-hero, that lane is `drovr-events-deliver-bulk-v1`.
   - It is throttled to 7 runs a minute of up to 100 bulk events each: at most **700 events a minute**. Inngest counts run starts, and it spaces them evenly through the minute.
   - Its producers are `BULK_DELIVERY_SOURCES` in `src/inngest/events/drovr.ts`: the Kit directory ingest, the contact-sync backfill and the evergreen pitch backfill.
   - Never loop `POST /events` or `POST /events/batch` at full speed. Never push a bulk job through the live lane (`drovr-events-deliver-v1`).
   - Any other producer paces itself to **≤ 750 births a minute**, and to ≤ 1,000 a minute counting the live signups at the time. At that rate a 130k import takes about 3 hours.
2. **Pick the start time so the daily repeats miss the calendar waves.** A value-path cohort's drips repeat at the same clock time for 7 days.
   - The import window must not overlap 15:30–16:30Z (the evergreen calendar wave) or 17:45–18:15Z (the shadow-newsletter PT minute).
   - Don't run during a launch send, or inside 11-09 … 11-15.
3. **Calendar journeys don't spread by pacing.** Evergreen and the shadow newsletter send at local calendar instants, so births paced over hours on one day still fire together.
   - Keep **≤ 60k births per local slot per UTC offset** at a 90-minute spread window, and ≤ 20k while the window is 30 minutes. Split the job across days to stay under.
   - The shadow slot counts every `contact.created`.
4. **Canary first:** one page (`maxPages: 1`, or `--limit 25`). Check drovr `/status` (overload 0, STUCK green), then resume.
5. **Watch:** drovr's D1 query time per minute (the shed line is about 7.3 s a minute), `overload` log lines, and the queue vital. **Pause the Inngest function at the first overload line.** The job's cursor resumes where it stopped.
6. **Don't backdate births into drip journeys.** ai-hero enforces this at the send (below). The directory seed backdates only the contact directory, which sends nothing. Check which journeys a job's events name.

## No bulk value-path births in the 201e window

**From 201e PR A's deploy (10-18 at the latest) until PR B's deploy (the spread window W raised, at least 7 days later), no bulk value-path births.** At W = 30 with anchored drips, every wave is concentrated (the hawk, 201e S2 guard 1).
- The bulk lane enforces it (`drovr-bulk-freeze.ts`). Inside the window, it drops every value-path `contact.created` from a bulk run, logs `drovr.bulk.value_path_births_refused` at error with the count and up to 20 keys, and counts `valuePathBirthsRefused` in the run's receipt. The rest of the run is delivered.
- The window opens at `DROVR_VALUE_PATH_BULK_FREEZE.from`, 2026-10-18 00:00Z. If PR A deploys earlier, set `AIH_DROVR_VALUE_PATH_BULK_FREEZE=on` on prod at its deploy.
- PR B closes it by setting `DROVR_VALUE_PATH_BULK_FREEZE.until` to its deploy instant. Until then the window stays open, so the guard fails closed.
- **A value-path import inside the window needs the hawk's sign-off.** Set `AIH_DROVR_VALUE_PATH_BULK_SIGNOFF` to the hawk's name and the date, run the import, then unset it. Each run it lets through logs `drovr.bulk.value_path_births_signed_off` with who signed.
- A refused birth is not outboxed. Re-run the import after the window, or with the sign-off.

## The clamp at the send

Every event leaves ai-hero through `deliverDrovrShadowEvent` (the single post, the replay and the fallback) or `deliverBatchOrThrow` (the bulk lane and the straggler retry). Both clamp a **sending-journey birth** to at most 5 minutes before the send:
- **A sending-journey birth** is a `contact.created` anywhere but `contact-directory`: value-path, the shadow newsletter, an owner copy. The evergreen offer's `course.sequence-exhausted` counts too.
- **Untouched:** directory births keep the contact's `createdAt`, and stops and facts keep their own time, because the time is the fact.
- **The key never changes.** drovr's event log is first-write-wins by idempotency key, so a clamped retry dedupes against the first post.
- **Every clamp is logged:** `drovr.birth.clamped` carries `path`, `count`, `maxLagSeconds` and each birth's `lagSeconds`. A burst of these lines with large lags is an outage backlog, or a backfill queued behind the throttle.
- **It composes with the outbox.** A birth that has failed for more than 24 hours is held for a human, never clamped and sent (`drovr-outbox-runbook.md`). A released held birth posts clamped, so its drips start from the release, not all at once.
- **Its effect on a calendar journey:** a clamped shadow-newsletter birth can move its first eligible Thursday a week later, never earlier. A clamped evergreen start moves the offer's slots later by the clamp, never earlier. The offer's `completedAt` in the payload keeps the real completion.

## The evergreen pitch backfill

`src/scripts/evergreen-pitch-backfill.ts` births each contact at its own instant, read as it dispatches, and shares that instant between ai-hero's entry and drovr's birth. Its batches ride the bulk lane (source `evergreen-pitch-backfill`).
- It waits 100 ms between births, at most 600 a minute against the lane's 700. So a birth never queues behind the throttle long enough to be clamped off the instant ai-hero's entry recorded.
- That matters because ai-hero's offer deadline comes from its entry, and drovr's comes from the birth's `occurredAt`. A `drovr.birth.clamped` line with `path: batch` during a backfill means they have drifted apart: stop and look.
- `--limit` bounds a run. Split a large population across days so that no local slot passes the calendar cap.
