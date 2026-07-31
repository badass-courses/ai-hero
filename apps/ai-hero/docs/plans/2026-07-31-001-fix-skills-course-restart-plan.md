---
title: 'fix: let an enrolled reader restart the skills email course'
type: fix
status: proposed
date: 2026-07-31
origin: Vojta, 2026-07-31 — "being able to retrigger the course like this makes sense"
---

# fix: let an enrolled reader restart the skills email course

## Summary

For a reader who has **already entered** the skills value path, the course CTA reports success and sends nothing. The button says *"You're already subscribed. One click starts the course."*, shows a confirmation, and the pipeline drops the request as an idempotent no-op.

The guard doing this is correct and should stay: it is what stops a double-submit, a webhook replay, or a reconciler pass from enrolling someone twice. What is missing is a way to say *"this one is deliberate"*.

Proposal: an explicit **restart** that mints a new attempt rather than a bypass that weakens the existing guard.

Not started. Needs Matt's sign-off before any code lands — it sends real email to real subscribers.

---

## Problem Frame

Traced from the CTA down:

```
SkillsCourseCta button
  └─ tagSubscriberAsSkills()                     skills-newsletter-actions.ts:23
       ├─ emailListProvider.subscribeToList()    → Kit form 9376133
       │     └─ decides the action's `success`   ← the lie starts here
       └─ inngest.send(skills-newsletter/subscribed)
             └─ enterSkillsNewsletterSubscriber()
                  └─ startValuePathGateDContact()  value-path-gate-d-start.ts:207
```

Two guards, both keyed identically on `(contact, valuePath, emailResourceId)`:

```js
const eventKey       = `contact:${id}:value-path:${slug}:start:${emailResourceId}`
const idempotencyKey = `contact:${id}:value-path:${slug}:email:${emailResourceId}`
if (existingEvent || existingIntent) return { status: 'idempotent-noop', ... }
```

Path entry always passes `emailResourceId = SKILLS_WORKFLOW_EMAIL_ZERO`, so after a first enrolment both keys are permanently occupied. `SideEffectIntent.idempotencyKey` carries a unique index, so the row cannot simply be rewritten.

Meanwhile `tagSubscriberAsSkills` returns `{ success: true }` off the Kit **form** call, which succeeds regardless. The UI has no idea the path entry no-opped.

### Two defects, not one

1. **No restart exists.** Deliberate re-entry is indistinguishable from an accidental replay.
2. **The UI reports a success it did not verify.** Even once (1) is fixed, the action should report what the pipeline actually did.

(2) is worth fixing on its own merits and is much cheaper. It can ship first.

### What is NOT wrong

Investigated and cleared on 2026-07-31:

- **Not a delivery incident.** Seven `kit-sequence-enrollment-retryable` intents on 2026-07-31 13:00–13:04 all completed at 13:40 via retry sweep. ~1,300 intents/day complete; permanent failures are ~1/week.
- **Not the Kit form's automation.** The pipeline is demonstrably the sender: 21,563 completed intents against sequence `2757199` ("AIH Skills Workflow, Individual, email-0"), ~3,300 active subscriptions.
- **Not the "already subscribed" copy.** That is `subscriber.state === 'active'` — an active Kit subscriber generally, which is the correct trigger for the tag-me variant. A reader can truthfully be "already subscribed" and never have entered this path.

---

## Requirements

**Restart is explicit.** A restart comes from a control that says restart. The ambient "Start the free course" CTA must not silently become a resend for enrolled readers — a reader clicking a CTA they have clicked before does not expect eight more emails.

**Restart is bounded.** A reader must not be able to loop the course arbitrarily. Proposed: at most one restart per contact per 30 days, enforced server-side, not in the UI.

**The existing guard keeps working.** Double-submit, webhook replay, and reconciler passes must still no-op. Only a request carrying a fresh restart token may create a new attempt.

**Honest reporting.** The action returns what the pipeline did — `enrolled` / `restarted` / `already-enrolled` / `blocked` — and the UI says that. No confirmation for a no-op.

**Auditable.** A restart is visible afterwards: who, when, which attempt. Reusing `ContactEvent` is preferred over a new table.

---

## Proposed Shape

### Attempt dimension in the key

Add an attempt ordinal to both keys, defaulting to 1 so every existing row keeps its meaning:

```js
const attempt = args.attempt ?? 1
const suffix  = attempt > 1 ? `:attempt:${attempt}` : ''
const eventKey       = `contact:${id}:value-path:${slug}:start:${emailResourceId}${suffix}`
const idempotencyKey = `contact:${id}:value-path:${slug}:email:${emailResourceId}${suffix}`
```

No backfill, no migration: attempt 1 is byte-identical to today's keys.

The caller resolves `attempt` by counting existing intents for `(contact, valuePath, email-0)` and adding one — so the ordinal is derived from state, not passed in from the client, and a replayed request lands on the same key it did the first time.

### Where the decision lives

`startValuePathGateDContact` should not decide whether a restart is allowed; it should be *told*. A new `allowRestart: boolean` (default false) on the entry input, set only by a dedicated restart action. Everything on the existing path continues to pass false and behaves exactly as now.

### New server action

`restartSkillsCourse()` alongside `tagSubscriberAsSkills`:

1. Resolve subscriber from cookie (same as today).
2. Look up their contact. No contact → they were never enrolled; delegate to the normal enrol path.
3. Check the 30-day bound against prior `value-path.restarted` contact events.
4. Emit the entry event with `allowRestart: true`.
5. Return a discriminated result the UI can render honestly.

### UI

A restart control only for readers the server confirms are enrolled, and worded as a restart — *"Start it again from lesson one"* — never as first-time enrolment. Precise placement is a design question, not settled here.

---

## Open Questions

1. **Does Kit resend a sequence to a subscriber already in it?** Adding to sequence `2757199` when they are already a member may be a no-op *on Kit's side*, in which case the restart needs to remove-then-add, which is destructive and changes their position. **This must be answered before implementation** — it decides whether the whole approach works. Not answerable from the API surface available here; needs a look in Kit, ideally a test with one throwaway address.
2. Is a restart the whole course from lesson one, or a resend of lesson zero only? Written above as the whole course.
3. Should the 30-day bound be per contact or global rate-limited too?
4. Does a restart re-run the finisher-field writes, or are those left at their existing values?

---

## Test Plan

- Unit: attempt 1 produces today's exact keys (guard against silent invalidation of 21k rows).
- Unit: `allowRestart: false` + existing intent → `idempotent-noop`, unchanged.
- Unit: `allowRestart: true` + existing intent → new intent at `:attempt:2`.
- Unit: replayed restart request → same key, no third intent.
- Unit: 30-day bound rejects a second restart.
- Integration: `tagSubscriberAsSkills` reports `already-enrolled` rather than `success` when path entry no-ops (ships independently of the rest).
- Manual: one throwaway Kit address end to end, confirming Q1 before any wider rollout.

---

## Risk

Sends real email to real subscribers. The blast radius is every already-enrolled contact if the restart is ever triggered non-deliberately, which is why the attempt ordinal is derived server-side and the ambient CTA is explicitly left alone.

Rollback is a deploy: the attempt suffix is additive and unreachable while `allowRestart` is false everywhere.
