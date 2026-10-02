# Shadow Newsletter: exit gate for new admissions

Deploy changes nothing for existing Shadow readers or new drovr-owned signups. Fresh app-owned signups skip legacy enrollment and receive a bound app-absence fact, so their normal Stage 3 birth and Shadow send continue. Readers with app legacy enrollment history, veterans, and genuinely unknown admissions remain gated; policy refusals persist a hold rather than failing or dropping the signup. The Kit rule and independent proof producer remain pending Joel/account owner. No live Kit changes, cleanup, merge, or deploy are part of this PR.

## Final review qualifications

### G1: app absence is not Kit absence

The `newsletter.old-sequence.absent` fact means **the app never enrolled this reader**. It does **not** mean the reader is absent from Kit sequence `2625552`. Its source is the app-owned signup branch that skips legacy enrollment, not a provider membership read. Kit forms, automations and manual adds can enroll a reader outside that branch. Covering those enrollments and invalidating local proof remains a producer requirement (M3).

### G2: returning signups can still be held

A returning drovr signup with a legacy enrollment record but no Shadow owner is now held at admission. It does not get the fresh-signup absence fact. The hold is durable, but its current operational visibility is only the `subscriber_funnel.newsletter_admission_held` log. Send-queue `held-for-exit` counts do not include an admission that has not created a send intent. There is no admission-hold dashboard or sweep in this change.

## Rulings and scope

- Each new drovr newsletter admission gets a `newsletter.exit-required` marker before any exit request. Only these readers enter the default send gate.
- Only the live `drovr-owned-signup` branch may record `newsletter.old-sequence.absent`, bound to the contact, `provider: kit`, `providerReference: kit:sequence:2625552`, and `payloadSummary.source: drovr-owned-signup` (the persisted JSON provenance). It requires no legacy subscription/enrollment-request record, no veteran/cohort or prior unknown admission evidence, and no earlier signup history. Merely missing history elsewhere is never proof. A newer app enrollment invalidates absence just as it invalidates exit proof. Veteran callers cannot write absence.
- Existing owners/readers without that marker keep sending exactly as before. `AIH_SHADOW_NEWSLETTER_EXISTING_EXIT_GATE_ENABLED` defaults off and **must stay off** until ruling B is satisfied and the operator explicitly approves the existing-reader migration.
- Unowned list handoffs retain the prior legacy subscription/backfill behavior and close the evergreen journey. A newly taken reader's marker prevents that legacy enrollment while admission is held.
- Veteran batches check protected-cohort evidence before any ownership write or tag request, even if an overlap reader has no newsletter owner row. `newsletter.shadow.protected-cohort` always excludes the reader. A trusted complete snapshot must attest `newsletter.shadow.cohort-clear` before a veteran may be taken. Missing snapshot evidence is counted as `cohortUnknown` and skipped, never treated as clear. This change imports no cohort data.

## Durable state machine

The transition sketch uses XState v5 vocabulary; persisted events/statuses are the actual runtime state, not a second in-memory engine:

```ts
createMachine({
  initial: 'unassigned',
  states: {
    unassigned: { on: { ADMIT: [
      { guard: 'appSignupAbsentOrIndependentExitProof', target: 'owned' },
      { target: 'admissionHeld' },
    ] } },
    admissionHeld: { on: { EXIT_RECEIPT: {
      guard: 'persistedCurrentProof', target: 'owned',
    } } },
    owned: { on: { SEND: [
      { guard: 'exemptOrProven', target: 'completed' },
      { target: 'sendHeld' },
    ] } },
    sendHeld: { on: { EXIT_RECEIPT: {
      guard: 'persistedCurrentProof', target: 'owned',
    } } },
    completed: { type: 'final' },
  },
})
```

Admission refusal writes the idempotent `newsletter.admission.held` contact event and returns normally. The signup Inngest function returns `newsletter: 'held'`; veteran batches count `held` and continue. No policy refusal burns an Inngest retry budget or births a newsletter actor. Exit-tag transport failures (429, 5xx, timeout) escape unchanged for Inngest retry, rather than becoming a permanent hold with no tag request. Admission read unavailability also escapes; only policy refusals become holds.

Send refusal sets `status: 'held-for-exit'`, records `lastError`, `reviewReasons`, and the **first** `exitHeldAt`, and spends no provider-send attempt. The active sender queries only `pending`, so held readers cannot occupy its batch limit or starve a proven reader. Scope/membership read unavailability leaves the row pending for the next cron, without attempts or completion. The sender receipt reports `newsletterQueue.pending` and `newsletterQueue.heldForExit` from app status counts; pending-summary surfaces also include held work with a separate held count.

After persisting an independent exit receipt, the producer emits `newsletter/old-sequence.exit-confirmed` with `contactId` and `receiptId`. The registered Inngest replay function verifies that exact receipt and current local membership. It replays any held admission using the saved identity, queues an idempotent authority newsletter birth with the saved admission provenance (signup, not veteran, for live signups), and re-arms that contact's exit-held intents to `pending`. Duplicate/stale notifications cannot fabricate proof or repeat completed sends. The producer must reliably retry notification delivery after the DB write; persisting proof without the notification is not a completed producer operation.

## Producer before rule flag: hard rollout gate

The new exit adapter requires **both**:

1. `AIH_SHADOW_NEWSLETTER_EXIT_PRODUCER_READY=true`, only after the independent proof producer, receipt replay notification, and recovery behavior are verified.
2. `AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY=true`, only after Joel/account-owner approval and verified UI-rule readback.

Set/verify the producer first. Never enable the rule flag ahead of the producer. Configure `KIT_SHADOW_NEWSLETTER_EXIT_TAG_ID` to the verified **new** `shadow-exit-2625552` tag. The adapter defaults to `unsupported`, never creates/configures Kit objects, and rejects the old `drovr-newsletter` and legacy backfill tag ids.

Readiness flags accept trimmed `true`/`TRUE` or `1`. Missing, false, or unrecognized values safely disable the feature and never fail application boot. Both flags still require explicit approval and verification.

The existing Kit tag client acknowledges only a request. A tag-added webhook or successful tag write is **not** proof of sequence removal and must not produce an exit-confirmed receipt. Existing readers/send-time checks never call this adapter.

## Proof contract and stale-proof producer requirement (M3)

Proof binds `contactId`, `provider: 'kit'`, and `providerReference: 'kit:sequence:2625552'`. `newsletter.old-sequence.exit-confirmed` must be newer than any `newsletter.old-sequence.subscribed` or `newsletter.old-sequence.enrollment-requested` record. Unknown history alone is not absence. The explicit app-owned-signup absence fact is a separate desk-approved proof of the skipped app enrollment, not a Kit scan or a claim about unseen provider automations. The legacy signup path records an enrollment request before touching the provider, so failed/ambiguous enrollments invalidate older proof too.

**Before enabling the producer**, inventory every path that can enroll `2625552`: app signups, the `22309615` backfill, Kit forms/automations, and manual adds. They must either record authoritative enrollment receipts that invalidate exit/absence proof or exclude readers with those receipts. In particular, a Kit form/automation must not enroll an app-owned signup behind the app's back without invalidating its absence fact. The producer must reconcile provider-side re-enrollments before claiming that its local receipt remains current. Without that coverage, stale local proof can allow duplicate delivery. No new importer, backfill behavior, or Kit-side enrollment instrumentation ships in this change.

## Cost and tests

Checks use local event records only. There are zero per-send Kit membership reads. Kit documents no subscriber-to-sequences read; absence via its sequence list would require every page, at most 1,000 readers per page. No such scan or cache was added.

RED-first regressions also cover fresh app-owned signup absence/birth/send, legacy and veteran holds, tag transport retry, membership read retry, lenient env schemas, signup replay provenance, and visible held counts. Earlier regressions cover non-throwing Inngest admission using the real assignment code, queue starvation with more than the batch limit held, existing-reader delivery with no proof, producer/rule flag ordering, unchanged unowned handoffs, and protected-cohort exclusion without an owner row. Receipt tests cover verified replay, re-arming, duplicates and stale/misbound proof.

Ready for review is not deployment approval. Opus review, application gates, producer verification, Kit rule approval/readback, and AI Hero's READY deploy gate remain required.
