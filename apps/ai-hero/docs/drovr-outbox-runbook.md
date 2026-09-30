# drovr outbox runbook

`AI_DrovrOutbox` keeps every drovr send that ran out of retries, and every stop that is owed (rows 204, 204b and 204c). The replay (`drovr-outbox-replay-v1`, cron `2-57/5`) re-posts them under their drovr idempotency keys, so a repeat is deduped by drovr. Every statement below is a **prod write**: the hawk decides, and the row ids go in the receipt.

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
  - The one exception is a whole-batch 404 or 405. That means drovr has no batch ingress, not an answer about the events, so the chunk retries and the replay later posts the stop alone. The gate is closed throughout.
  - Facts and births keep their own rules: a fact's 4xx other than `event-not-live` is rejected.
  - The dispatch fallback (a direct post when Inngest is unreachable) outboxes a refused stop as pending. The replay's re-post then holds it within 5 minutes.
- **A backfill stop drovr answers `event-not-live`** goes to the contact-sync straggler retry, and is also outboxed (pending, source `contactSync`, due in 24 hours) so it gates its contact while it waits. The straggler retry settles it when drovr takes it, or holds it if drovr refuses it. After a day the replay posts it too; drovr dedupes by key.
- **A birth never waits behind a stop that is itself waiting for a birth.** drovr takes no stop for a contact it never saw born, so the birth goes first and the stop right after it, in the same run. That is what keeps the two gates from deadlocking.
- **A stop is captured on its first live failure**, not after Inngest's retries. Its row is pending with a `nextAttemptAt` about 79 minutes out (the rest of the retry ladder). The replay leaves it alone until then, but it gates at once. A retry that lands marks it delivered (`drovr.outbox.settled_by_retry`), and makes the contact's facts that waited behind a stop (their `lastError` says so) due again, so they post on the next run instead of at the window's end. The contact's other stops keep their windows, and so does a fact waiting out its own Retry-After.
  - The window counts this attempt's Retry-After and the backoff table after it. If drovr sends long Retry-After hints on later attempts too, Inngest's retries can run past the window by up to the sum of those hints. The replay may then post the stop while a retry does too, and drovr dedupes the second post by its idempotency key.
- **Live delivery reads this table once per batch** (the stop gate, on `DrovrOutbox_contact_idx`). A failed read retries; on the last attempt the whole batch goes to the outbox, never posted unchecked. If the database is down past the retry ladder, the capture fails too: the events are then only in the logs (`drovr.outbox.capture_failed`, with their keys).

## What a row is holding back (read-only)

```sql
SELECT id, eventType, journeyId, status, occurredAt, nextAttemptAt, lastStatus, lastError
FROM AI_DrovrOutbox
WHERE target = 'production' AND contactId = ? AND status IN ('pending', 'held', 'rejected')
ORDER BY occurredAt;
```

## A held stop: decide, then re-send or retire (audited)

1. Read why drovr refused it: `lastStatus` and `lastError` hold the status and drovr's problem.
   - A 401 or 403 is a key or tenant problem.
   - A 404 `unknown-route` means a wrong or unset `DROVR_SHADOW_INGEST_URL`.
   - A 404 `unknown-journey` is a journey that isn't live yet.
   - A 400 `malformed-event` is an ai-hero bug.
   - A 410 `tenant-retired` is a drovr decision.
   - A 409 `cold-start-unhandled` means the contact has no actor on that journey, and the stop does not start one. Find out why the contact isn't there (a missing birth, or a journey the contact was never on) before re-sending.
2. Fix the cause first, then **re-send** it with the statement under "Release a held or rejected row". Put who and why in `lastError`, as that statement does.
3. **Retire** it only when the stop is truly moot (see "Retire a row"). A purchase is never retired.
4. Post the row ids, the decision and the reason to the desk as a `done` item: that is the audit trail. Delivered rows are purged after 7 days.

## Release a held or rejected row

It posts at the next run; drovr dedupes by key if it already has it.

```sql
UPDATE AI_DrovrOutbox SET status = 'pending', releasedAt = NOW(3), nextAttemptAt = NOW(3),
  lastError = LEFT(CONCAT('released by <name> <ISO time>: <why>; was: ', COALESCE(lastError, '')), 1000)
WHERE status IN ('held', 'rejected') AND id IN (…);
```

`lastError` is `varchar(1000)`, and a refusal already fills it, so the `LEFT` keeps the update from failing (MySQL error 1406). Double any `'` in `<why>`.

Then send `drovr/outbox.replay-requested`, or wait for the next :x2/:x7 tick. A row drovr refuses for good is refused again, so release alone won't end the hold: read `lastError` first.

## Retire a row (it never posts)

Its gate lifts and the rows behind it post at the next run. Delivered rows are purged after 7 days, so record the retirement in the row log too.

**A purchase is never retired.** Retiring `purchase.recorded` means drovr never learns of the purchase, so the buyer is pitched P2–P5: nothing but drovr knowing stops that. This statement refuses one:

```sql
UPDATE AI_DrovrOutbox SET status = 'delivered', deliveredAt = NOW(3), lastError = 'retired by hand: <reason>'
WHERE status IN ('held', 'rejected') AND eventType <> 'purchase.recorded' AND id IN (…);
```

A purchase drovr keeps refusing is a drovr bug: fix it there, then release the row. The exception is drovr's `contact-never-born` on an owner copy, which is the correct answer and is released on its own; it is never held. Until then it stays held, its facts stay held, and the held-stop monitor pages after a day, which is right: the buyer must not be pitched.

- **Unsubscribe, bounce and complaint** are also refused at send time by Kit and by ai-hero's `contact-stop-rule`, so retiring one of those loses less. It still leaves drovr's own record wrong.
- **A retired birth** releases the rows behind it. A stop that waited for it then posts alone. If drovr answers never-born, an owner copy is released; a directory stop is held, since it is the suppression authority.

## Limits

- **Source `contactSync` is not always deferred:** the stop alert gives every pending `contactSync` stop 48 hours, including a straggler or profile-sync stop captured because drovr was down, which is due now. The `oldest` alert (60 minutes) still fires for it.
- **A stop deferred again on a bulk retry:** a stop first captured on a 5xx (source `bulk`), whose retry is then answered `event-not-live`, keeps its 10-minute `stop` alert. It gates correctly and the straggler retry settles it, but it can page for a while before that.

- Holding later facts stops new email that an overtaking fact would start. It can't stop timers drovr already scheduled; only delivering the stop does. Hence the `stop` alert.
- If Inngest runs a stop's retries later than its window (its own queueing, or later Retry-After hints), the replay may post the stop while a retry does too. drovr dedupes the second post by its idempotency key.
