# Shadow Newsletter: exit gate for new admissions

Deploy changes nothing for existing Shadow readers or new drovr-owned signups. Fresh app-owned signups skip legacy enrollment and receive a bound app-absence fact, so their normal Stage 3 birth and Shadow send continue. Readers with app legacy enrollment history, veterans, and genuinely unknown admissions remain gated; policy refusals persist a hold rather than failing or dropping the signup. The Kit rule and independent automatic proof producer remain pending the account owner. A guarded, operator-invoked single-contact producer exists for held evergreen handoffs. It does not enable either readiness flag or change the automatic admission path.

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

## Operator recovery: batch plans, single-contact writes

Run from `apps/ai-hero` with the intended deployment's environment loaded. Keep the same database, Kit account, Inngest application and `VERCEL_ENV` for the plan, write and readback. `--drovr-contact-id` is an alternative to `--contact-id`: the delivery path carries the AI Hero contact identifier unchanged. There is no email lookup or new identity link.

```sh
pnpm exec tsx -r dotenv/config scripts/held-exit-recover.ts --contact-id <contact-id>
pnpm exec tsx -r dotenv/config scripts/held-exit-recover.ts --contact-id <contact-id> --write --approval <ref> --plan-hash <dry-run-hash>
pnpm exec tsx -r dotenv/config scripts/held-exit-recover.ts --contact-id <contact-id> --readback
```

Dry-run is the default. Repeat `--contact-id` or `--drovr-contact-id` for a batch plan. One full scan serves every contact; `results` follow selector order and omit identifiers. Each planned result has its own hash bound to the shared scan fingerprint. Present members and unproven identities refuse individually, without hiding other results. Batch writes and batch readbacks are rejected before loading clients. Each contact requires exactly one Kit-backed, exit-held `subscribe-evergreen-list` row for `shadow-newsletter`, its canonical contact/list key, and one bound Kit identity. Unknown identities, missing or ambiguous holds, and already-recovered rows refuse without writes. The JSON envelope reports counts, booleans, fixed operation/status labels, scan times and a plan hash, never contact identifiers, addresses, names, approval references or provider errors.

The Kit read uses `GET /v4/sequences/2625552/subscribers?status=all`. The [v3 subscriber](https://developers.kit.com/api-reference/v3/subscribers) and [v3 sequence](https://developers.kit.com/api-reference/v3/sequences) docs offer no per-subscriber sequence-membership read. The [v4 sequence list](https://developers.kit.com/api-reference/sequences/list-subscribers-for-a-sequence) also has no subscriber-id filter. The signup's `probe-shadow-newsletter-sequence` is an enrollment POST and is not reused.

Every page must complete before absence can be established. Partial, malformed, stale, errored or page-capped scans never prove absence. Missing or repeating cursors and duplicate subscriber records refuse. The scan has a 500-page cap, 1,000 records per page and a 60-second request timeout. Only GETs retry: 5xx, 429 and request timeouts get at most five attempts per page, always at the same cursor. Other failures, including 404 and malformed pages, do not retry. Backoff doubles with jitter and honors Retry-After; a delay above the 60-second backoff cap refuses rather than retrying earlier than the provider requested.

`MAX_SCAN_AGE_MS` is 30 minutes, measured from scan start, not completion. This accommodates deep pagination at tens of seconds per page plus bounded retries without accepting an indefinitely old snapshot. A completed scan can be reused only within that bound. An expired checkpoint starts a new scan. Any membership, including cancelled or inactive subscribers, requires a human instead.

The invoking operator owns the private on-disk checkpoint under the user's cache directory, in `ai-hero/held-exit/<scope-hash>.json`. The scope binds the deployment, database and provider configuration. Files use mode 0600; newly created directories use 0700. Checkpoints hold the next cursor, scan-start time, counts and hashed membership, never provider bodies or credentials. Each parsed page is saved atomically, so a later failure or interrupted process can resume from the last saved cursor. One exclusive `.lock` file permits one scanning process per scope. Normal exit removes that lock. After a crash, the operator must verify that the owner process has stopped before removing its abandoned lock or temporary file. Do not reclaim a live process's lease.

The operator removes checkpoint files after the approved recovery session and no later than the next day. Expiry prevents reuse but does not delete a file automatically. Do not commit or upload these private files. A corrupt checkpoint refuses; inspect it privately and remove the operator-owned file before starting a fresh plan.

Write requires a nonempty approval reference and the exact dry-run hash. The hash binds the contact snapshot, shared scan fingerprint and private database/deployment/provider fingerprints; configuration or credential changes require a new plan. Writes remain single-contact. The command reuses a complete scan within the freshness bound or rescans; a new fingerprint requires a new dry-run plan and approval. It repeats the identity, row and provider checks, then re-reads the contact and local gate history before persistence. It uses the existing `normalizeContactEvent` and `createContactEvent` writer for `newsletter.old-sequence.exit-confirmed`, bound to `kit:sequence:2625552`. The proof instant is the start of the scan, not a fabricated provider removal time. The persisted summary records the approval reference, hash, sequence, page/record counts and scan times without an address. The current local exit guard must accept the proof before the script emits `newsletter/old-sequence.exit-confirmed` with the persisted receipt. The notification has a deterministic receipt-based event key. Only the existing replay function assigns admission and re-arms held work; the script does not directly change ownership, enroll in Kit, rearm rows or fabricate `shadow.entered`.

`requested` means Inngest accepted the wakeup, not that recovery completed. A refusal after receipt persistence reports that persisted proof separately; it does not pretend the write was rolled back. If notification delivery fails, obtain a fresh plan and approval before another write. A recovered row refuses without a new receipt or notification.

Readback performs no Kit read or writes. It reports row status, `completedAt`, and outbox counts scoped to the deployment, contact, tenant, journey, `shadow.entered` type and `completion:<original intent key>`. It uses the sender's completion mapper and exposes SHA-256 fingerprints of the original intent and completion keys for private trace matching, never the raw keys. A delivered outbox record confirms dispatch; a recorded attempt reports attempted; no durable receipt reports unknown. A completed row and empty outbox do not prove direct delivery. Resolve unknown dispatch with independent delivery evidence before declaring recovery proven.

This command does not replace the automatic producer, inventory provider-side re-enrollment paths, configure Kit rules, or authorize a production run. Those rollout gates remain below.

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

Checks use local event records only. There are zero per-send Kit membership reads. Kit documents no subscriber-to-sequences read; absence via its sequence list would require every page, at most 1,000 readers per page. There is no per-send scan or cache. The operator recovery above performs a bounded, shared batch scan only when invoked. Retry schedules, exact cursor resume, exhaustion, terminal HTTP errors, timeouts, batch outcomes and freshness boundaries have fixture tests. Property tests require transient schedules under the retry cap to preserve membership and forbid absence from partial or stale scans.

RED-first regressions also cover fresh app-owned signup absence/birth/send, legacy and veteran holds, tag transport retry, membership read retry, lenient env schemas, signup replay provenance, and visible held counts. Earlier regressions cover non-throwing Inngest admission using the real assignment code, queue starvation with more than the batch limit held, existing-reader delivery with no proof, producer/rule flag ordering, unchanged unowned handoffs, and protected-cohort exclusion without an owner row. Receipt tests cover verified replay, re-arming, duplicates and stale/misbound proof.

Ready for review is not deployment approval. Opus review, application gates, producer verification, Kit rule approval/readback, and AI Hero's READY deploy gate remain required.
