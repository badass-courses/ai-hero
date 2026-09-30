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
3. **Email 0:** the two email 0 sequences, read only for the days on which the remaining subscribers' Kit records were created, padded a day each side. Slices are half-open (`created_after` inclusive, `created_before` exclusive, measured 2026-09-30) and at most 7 days long; they're read in parallel. A subscriber in either sequence already got course email and is never entered.
4. **Per candidate, newest signup first:** a fresh `GET /v4/subscribers/{id}/tags` against the AI Hero and AI Skills unsubscribe tags (19251081, 8244351). If the subscriber is clear, their `skills-newsletter.subscribed` event is sent **at once**, in its own step. Then the next candidate.
5. **At most 50 sends a run** (`AIH_SKILLS_CONFIRMATION_RECONCILIATION_LIMIT` can pause it with 0 or lower it, never raise it). The rest are counted `deferred` and go next run.

Each event's id is `skills-confirmed:<form>:<subscriber>`, which is its idempotency key. Inngest drops a repeat, so a rerun, a retried step, or the daily tier overlapping the recent one enters a subscriber once.

## Kit budget

Kit allows an API key **120 requests per rolling minute**, shared with everything else AI Hero does in Kit.
- **At most 4 requests at once, at most 40 starts a minute.** Each step waits out the pace before it ends, so the next step keeps it.
- **429:** the reader waits out `Retry-After` (seconds or a date, at most 60 s; 1 s, 2 s, 4 s without one), and every request of the reader waits with it. **Still 429 after 4 attempts: fail closed.**
- **5xx or no answer:** 3 attempts, then fail closed.
- **A run's cost:** an empty run is 5 requests. A run with candidates adds 2 per email 0 slice (usually 1 slice), plus 1 per candidate checked. The old run, before row 211, was about 51 (every tag and sequence list in full) and took ~7 min.

## Fail closed

Nobody is entered on partial evidence.
- **The form, a local evidence query, or an email 0 slice fails:** the run fails and sends nobody. A stale Contact email key does the same. Inngest retries the run twice; the next poll tries again.
- **A tag check fails** (403, a malformed answer, a 5xx after the retries, 429 after the backoff): that subscriber is not sent, nor anyone after them in the run. Those sent before them stay sent. The step retries, then the run fails; the next poll goes on.
- **A subscriber Kit no longer has** (404 on the tags) is not sent, and the run goes on. It's counted `notInKit`.

## Logs

Axiom, dataset `vercel`, project `ai-hero`.
- **Each send:** `subscriber_funnel.confirmation_reconciled` with `formId`, `kitSubscriberId`, `eventId`.
- **Each run:** `subscriber_funnel.confirmation_reconciliation_completed` with:
  - `tier` (`recent` or `daily`) and its `window`;
  - the tier's counts: `kitFormSubscribersFetched`, `inWindow`, `unconfirmed`, `withExistingCourseEntry`, `excludedOptedOut` (local plus tags), `excludedByTag`, `excludedCourseHistory` (local, the completion field and email 0), `candidates`, `tagChecked`, `notInKit`, `planned` (sent), `deferred`;
  - `plannedOlderThanRecentTier`: sent by the daily tier, who joined the form more than 14 days before. It's the daily tier's catch;
  - `kit.calls` (every Kit request, retries included) and `kit.throttled` (the 429s among them).
- **Read it:** `kit.throttled` above 0 on more than the odd run means AI Hero's Kit key is near its limit; look for another heavy Kit job. A run that stops logging `completed` is failing closed: look for `ReconcilerEvidenceUnavailableError` on the function in Inngest.

## Later

- A Kit webhook for confirmations (option d) is deferred until after launch. It may be moot once drovr's DOI (drovr #542) replaces the poll.
