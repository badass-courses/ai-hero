# drovr outbox runbook

`AI_DrovrOutbox` keeps every drovr send that ran out of retries (rows 204 and 204b). The replay (`drovr-outbox-replay-v1`, cron `2-57/5`) re-posts them under their drovr idempotency keys, so a repeat is deduped by drovr. Every statement below is a **prod write**: the hawk decides, and the row ids go in the receipt.

## What to watch

- `drovr.outbox.depth` every 5 minutes: `pending`, `held`, `rejected`, `oldestPendingAgeMin`, `oldestOpenStopAgeMin`.
- `drovr.outbox.alert` with `reasons`. It fires on every run until the cause is gone; the Axiom monitor `aihero-drovr-outbox` counts it:
  - `pending`: more than 25 rows waiting;
  - `oldest`: a row waiting for more than 60 minutes;
  - `held` / `rejected`: a birth newly held, or a 4xx on replay;
  - `stop`: a stop (unsubscribe, bounce, complaint, purchase) still owed after 10 minutes, pending or rejected. A stop a human set to `held` gates its facts but does not page.

## The gates

- **A birth** (`contact.created`, or a signup) that is pending or held holds that contact's rows on its journey; a signup holds every row of the contact.
- **A stop** that is pending, held or **rejected** holds every row of its contact that happened at or after it, on any journey. A refused stop fails closed: its facts wait an hour at a time until a human acts.
- **A birth never waits behind a stop that is itself waiting for a birth.** drovr takes no stop for a contact it never saw born, so the birth goes first and the stop right after it, in the same run. That is what keeps the two gates from deadlocking.
- **A stop is captured on its first live failure**, not after Inngest's retries. Its row is pending with a `nextAttemptAt` about 79 minutes out (the rest of the retry ladder). The replay leaves it alone until then, but it gates at once. A retry that lands marks it delivered (`drovr.outbox.settled_by_retry`).
- **Live delivery reads this table once per batch** (the stop gate, on `DrovrOutbox_contact_idx`). A failed read retries; on the last attempt the whole batch goes to the outbox, never posted unchecked. If the database is down past the retry ladder, the capture fails too: the events are then only in the logs (`drovr.outbox.capture_failed`, with their keys).

## What a row is holding back (read-only)

```sql
SELECT id, eventType, journeyId, status, occurredAt, nextAttemptAt, lastStatus, lastError
FROM AI_DrovrOutbox
WHERE target = 'production' AND contactId = ? AND status IN ('pending', 'held', 'rejected')
ORDER BY occurredAt;
```

## Release a held or rejected row

It posts at the next run; drovr dedupes by key if it already has it.

```sql
UPDATE AI_DrovrOutbox SET status = 'pending', releasedAt = NOW(3), nextAttemptAt = NOW(3)
WHERE status IN ('held', 'rejected') AND id IN (…);
```

Then send `drovr/outbox.replay-requested`, or wait for the next :x2/:x7 tick. A row drovr refuses for good is refused again, so release alone won't end the hold: read `lastError` first.

## Retire a row (it never posts)

Its gate lifts and the rows behind it post at the next run. Delivered rows are purged after 7 days, so record the retirement in the row log too.

**A purchase is never retired.** Retiring `purchase.recorded` means drovr never learns of the purchase, so the buyer is pitched P2–P5: nothing but drovr knowing stops that. This statement refuses one:

```sql
UPDATE AI_DrovrOutbox SET status = 'delivered', deliveredAt = NOW(3), lastError = 'retired by hand: <reason>'
WHERE status IN ('held', 'rejected') AND eventType <> 'purchase.recorded' AND id IN (…);
```

A purchase drovr keeps refusing is a drovr bug: fix it there, then release the row. Until then its facts stay held and the `stop` alert keeps firing, which is right: the buyer must not be pitched.

- **Unsubscribe, bounce and complaint** are also refused at send time by Kit and by ai-hero's `contact-stop-rule`, so retiring one of those loses less. It still leaves drovr's own record wrong.
- **A retired birth** releases the rows behind it. A stop that waited for it then posts alone, and drovr answers never-born (the replay settles it).

## Limits

- Holding later facts stops new email that an overtaking fact would start. It can't stop timers drovr already scheduled; only delivering the stop does. Hence the `stop` alert.
- If Inngest runs a stop's retries later than its table, the replay may post the stop while a retry does too. drovr dedupes the second post by its idempotency key.
