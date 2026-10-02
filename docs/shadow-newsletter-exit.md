# Shadow Newsletter: old-sequence exit gate

The send gate is implemented. The Kit exit rule and its completion-proof importer are **not** implemented or approved by this change. Until the app has a verified exit receipt, every reader with present or unknown old-sequence membership is held. This can hold all existing Shadow sends; it is not a claim that newsletter delivery is ready.

## Ruling A: refuse before exit proof

Before a new newsletter ownership assignment, a veteran birth, an existing-owner birth replay, a Shadow email enrollment, or an owned list handoff completion, check the app's local sequence receipts.

- An old enrollment/subscription record means present until a newer confirmed exit exists.
- Missing history means unknown, not absent. Ownership and a tag-write acknowledgement do not prove exit.
- Present or unknown membership refuses admission with a retryable error. No newsletter birth is written or queued.
- At send time, refusal leaves the intent `pending`, records `old-newsletter-exit-unconfirmed` in `lastError` and `reviewReasons`, and returns `retry`. It never spends the provider-send attempt budget, dispatches a completion, or drops the row.
- A list handoff cannot re-add the reader to `2625552`. Without newsletter ownership it stays pending; with ownership and exit proof it completes without a Kit enrollment.

The membership check reads three event types from the local repository. It makes **zero Kit membership reads**. Kit documents no subscriber-to-sequences read. Its sequence list supports at most 1,000 subscribers per page, so confirming one reader's absence would require a complete sequence scan. There is no such scan or membership cache in this implementation.

## Exit request adapter, pending account-owner approval

`endOldSequenceMembership` requests the NEW tag `shadow-exit-2625552` through the existing `addSubscriberToKitTag` client. The account owner must create/verify the tag and configure the UI-only rule that removes tagged readers from sequence `2625552`.

The adapter defaults to `unsupported`. It writes nothing until both are configured:

- `AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY=true`, after approval and a verified rule readback.
- `KIT_SHADOW_NEWSLETTER_EXIT_TAG_ID`, the verified id of **shadow-exit-2625552**.

It rejects the existing `drovr-newsletter` tag (`23763332`) and legacy backfill tag (`22309615`). It does not create tags, configure rules, globally unsubscribe readers, or call an invented sequence-member DELETE.

Even a successful exit-tag write only means `requested`. The gate rereads the app receipts and still refuses unless independent completion proof exists. No default tag-write path creates that proof.

## Local receipt contract

All sequence receipts bind `contactId`, `provider: 'kit'`, and `providerReference: 'kit:sequence:2625552'`.

- `newsletter.old-sequence.subscribed`: historical confirmed legacy enrollment.
- `newsletter.old-sequence.enrollment-requested`: conservatively recorded before the legacy signup path can attempt enrollment. Failed or ambiguous enrollment still invalidates older exit proof.
- `newsletter.old-sequence.exit-confirmed`: independent proof that the reader left the old sequence. Its `occurredAt` must be newer than every local subscription/enrollment request.

This change **does not** add a completion-proof producer, import old memberships, or manufacture absence from missing records. The future verified rule-completion/readback importer owns that proof. A tag-added webhook or tag acknowledgement alone must never write `exit-confirmed`.

## Ruling B: no retroactive cleanup

Existing newsletter owners and send-time checks never call the exit request adapter. They read app records and hold unproven sends. Only a new admission may request the approved exit tag. No sweep, backfill, existing-cohort retagging, merge, or deployment is part of this change.

## Tests and rollout

The new-entrant and veteran RED admissions now throw retryable refusals without births. Their Shadow-send regressions leave visible pending rows. Tests also cover repeated holds past the send attempt budget, successful independent proof, idempotent delivery, owner replay, list handoffs, failed reads/exit requests, tag acknowledgements without proof, and rejection of the old tags.

Open for review, not deployment approval. Account-owner approval, rule setup/readback, the completion-proof importer, Opus review, and the application READY deploy gate still apply.
