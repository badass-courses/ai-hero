# Skills confirmation reconciler

A double opt-in learner is entered (contact, owners, drovr birth) only after Kit reports them confirmed. Kit has no webhook registered for AI Hero, so `skills-newsletter-confirmation-reconciler` polls for them. Its run is the whole wait between a learner confirming and their welcome. Code: `src/inngest/functions/skills-newsletter-confirmation-reconciler.ts` and `src/lib/subscriber-marketing/signup-confirmation-reconciler.server.ts`.

## Tiers

The scan is bounded by tiers, never by dropping anyone (row 211, the hawk).

| tier | when | which form signups |
|---|---|---|
| **recent** | every 15 min, `2,17,32,47 * * * *` | joined the form in the last **14 days** |
| **daily** | once a day, `9 5 * * *` (05:09Z) | every signup since the floor |

- **Nobody is dropped:** a learner who confirms on day 20 is entered by the next daily run, up to a day later.
- **The floor** is `SKILLS_CONFIRMATION_RECONCILIATION_START`, 2026-09-25. Joel's call: the backlog stranded before it is let go, not enrolled. The tiers only split what's above it.
- The minutes stay off the quarter hours (the contact-sync reconcile), the fives, and :40 (the owner-birth guard). `concurrency: 1` queues a run that outlasts its slot, so the daily run never overlaps a poll.

## One run

1. **The form:** every state of form 9376133 since the tier's start, the states read in parallel. That's 5 Kit requests.
2. **Local evidence:** entries, local opt-outs, value-path sends, and the completion field. **If nobody is left, the run ends here, and Kit is not asked for any list.** Most polls end here.
3. **Email 0 and the opt-out tags:** the two email 0 sequences and the AI Hero and AI Skills unsubscribe tags (8244351, 19251081). All four are read only for the days on which the remaining subscribers' Kit records were created, padded a day each side, in one batch. Slices are half-open (`created_after` inclusive, `created_before` exclusive, measured 2026-09-30 on a sequence and on both tags) and at most 7 days long; they're read in parallel.
   - A subscriber in either sequence already got course email and is never entered.
   - A subscriber with either tag opted out and is never entered. A Kit-tag opt-out is never recorded locally, so it's excluded here, before the per-candidate checks and their cap. That way 100 opt-outs can never starve an older consenting subscriber.
4. **Per candidate, newest signup first:** one more, fresh `GET /v4/subscribers/{id}/tags`, which catches a tag applied since the scan. If the subscriber is clear, their `skills-newsletter.subscribed` event is sent **at once**, in its own step. Then the next candidate.
5. **At most 50 sends a run** (`AIH_SKILLS_CONFIRMATION_RECONCILIATION_LIMIT` can pause it with 0 or lower it, never raise it). The limit counts sends, not checks.
6. **At most 100 tag checks a run,** so a run stays inside its slot and Inngest's step cap. Opt-outs never reach the checks (step 3), so only a subscriber Kit answers 404 for, or one whose check keeps failing, can use the cap. The rest are counted `deferred` and go next run. A daily run that ends with anyone deferred logs `subscriber_funnel.confirmation_daily_deferred` at warn; a monitor on it is a follow-up.

Each event's id is `skills-confirmed:<form>:<subscriber>`, which is its idempotency key. Inngest drops a repeat, so a rerun, a retried step, or the daily tier overlapping the recent one enters a subscriber once.

## Kit budget

Kit allows an API key **120 requests per rolling minute**, shared with everything else AI Hero does in Kit.
- **At most 4 requests at once, at most 40 starts a minute.** Each step waits out the pace before it ends, so the next step keeps it.
- **429:** the reader waits out `Retry-After` (seconds or a date, at most 60 s; 1 s, 2 s, 4 s without one), and every request of the reader waits with it, including one that had already reserved its start slot. Only requests already on the wire when the 429 comes back can't be recalled: at most 3, since at most 4 run at once. **Still 429 after 4 attempts: fail closed.**
- **A failed read stops its batch.** Once one email 0 or tag slice fails, no queued or waiting slice read of that run reaches Kit.
- **5xx or no answer:** 3 attempts, then fail closed.
- **The 429 wait lives in one step's reader.** If a step fails and Inngest retries it, the new reader starts at once. So 429 exhaustion plus 2 step retries is at most 12 requests at a throttled key. That's bounded, and it still sends nothing.
- **A run's cost** (`kit.calls` on each run's receipt): an empty run is 5 requests. A run with candidates adds 4 per slice (2 sequences and 2 tags; usually 1 slice), plus 1 per candidate checked: about 12–15 at 2–6 confirmations a poll. The old run, before row 211, was about 51 (every tag and sequence list in full) and took ~7 min.

## Fail closed

Nobody is entered on partial evidence.
- **The form, a local evidence query, or an email 0 or opt-out tag slice fails:** the run fails and sends nobody. That includes a 4xx, a body that isn't JSON, a malformed page, a next page without a cursor, and a pager past its cap. A stale Contact email key does the same. Inngest retries the run twice; the next poll tries again.
- **One subscriber's tag check fails** (a 4xx other than 404, a malformed or endless page, a 5xx or no answer after the retries): **that subscriber is skipped, unsent**, counted `tagFailed`, logged `subscriber_funnel.confirmation_tag_check_failed`, and checked again next poll. The run goes on to the older candidates, so one bad record never stalls the day-20 confirmers behind it.
- **3 tag checks failing in a row** means Kit, not the subscribers: the run stops, closed.
- **Kit still answering 429 after the backoff,** on any read: the run stops, closed. The key is throttled, so it doesn't go on to other subscribers.
- **A subscriber Kit no longer has** (404 on the tags) is not sent, and the run goes on. It's counted `notInKit`.
- Subscribers sent before a stop stay sent. A retry resends the same event ids, which Inngest drops.

## Logs

Axiom, dataset `vercel`, project `ai-hero`.
- **Each send:** `subscriber_funnel.confirmation_reconciled` with `formId`, `kitSubscriberId`, `eventId`.
- **Each run:** `subscriber_funnel.confirmation_reconciliation_completed` with:
  - `tier` (`recent` or `daily`) and its `window`;
  - the tier's counts: `kitFormSubscribersFetched`, `inWindow`, `unconfirmed`, `withExistingCourseEntry`, `excludedOptedOut` (local plus tags), `excludedByTag` (at the scan plus at the fresh check), `excludedByFreshTagCheck`, `excludedCourseHistory` (local, the completion field and email 0), `candidates`, `tagChecked`, `notInKit`, `tagFailed`, `planned` (sent), `deferred`;
  - `plannedOlderThanRecentTier`: sent by the daily tier, who joined the form more than 14 days before. It's the daily tier's catch;
  - `kit.calls` (every Kit request, retries included) and `kit.throttled` (the 429s among them).
- **Each skipped tag check:** `subscriber_funnel.confirmation_tag_check_failed` with `kitSubscriberId` and `reason`. The same subscriber failing run after run is a bad record to look at in Kit.
- **Read it:** `kit.throttled` above 0 on more than the odd run means AI Hero's Kit key is near its limit; look for another heavy Kit job. A run that stops logging `completed` is failing closed: look for `ReconcilerEvidenceUnavailableError` on the function in Inngest.

## After a deploy that touches the crons

The first 05:09Z run must log `tier: "daily"` with `window.from` at the floor (2026-09-25). That's the only proof that Inngest's cron payload (`event.data.cron`) is what the code reads. If it logs `recent`, nobody older than 14 days is ever entered: fix it that day.

## Later

- A Kit webhook for confirmations (option d) is deferred until after launch. It may be moot once drovr's DOI (drovr #542) replaces the poll.
