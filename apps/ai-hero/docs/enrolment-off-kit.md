# Owned Skills enrolment

`AIH_ENROLMENT_OFF_KIT_ENABLED=true` moves the signed-in Skills action onto the owned contact directory, form-specific drovr consent and the existing course-owner birth. It defaults off. No environment values change in this PR.

## Behaviour

- `tagSubscriberAsSkills` verifies that the reader is signed in as the server-resolved address before taking the new branch. A cookie alone does not qualify.
- The owned directory and `GET /contact-list-state` resolve identity and consent. Only a confirmed `forms[]` entry for `skills-newsletter` qualifies. A confirmed profile or an unrelated confirmed form does not.
- Unknown, missing, unconfirmed or unsubscribed Skills evidence takes the existing drovr DOI request path. A bounce or complaint refuses. No Kit lookup or legacy fallback runs.
- The event carries `contactId`. `kitSubscriberId` remains an optional compatibility alias on owned events; legacy producers retain their required Kit-id contract.
- The worker rechecks consent and local stops, captures an `ai-hero` identity, and uses the existing journey-owner decision and birth emitter. It records the owned course-entry/access fact after ownership, preserves timezone evidence and requests the existing profile sync. The legacy drip defers to the recorded owner.
- Existing owners remain sticky. An in-flight legacy course is not migrated or restarted. An owner rollout that selects legacy refuses a new owned entry rather than calling the Kit planner.
- No old-sequence `2625552` request or shadow-newsletter birth runs on this branch. Course enrolment does not grant newsletter consent.
- Only the optional form projection can call Kit. It runs after owned entry, behind `AIH_KIT_MIRROR_WRITES_ENABLED`; a failed projection does not undo enrolment. Set the mirror switch to `false` for zero form writes. The master switch's existing default-on semantics stay unchanged.
- Signed-out and cookie-only readers keep their existing form/DOI behaviour. `DROVR_DOI_FORMS` must continue to route Skills form `9376133` to drovr for a complete Kit-free funnel.

## Caller inventory

Search: `grep -rn '5470956\|9376133' apps/ai-hero/src`, then follow `SKILLS_COURSE_FORM_ID`, `SKILLS_FORM_ID` and `SKILLS_NEWSLETTER_SUBSCRIBED_EVENT`.

There are no callers or literals for `5470956` on the base. The active Skills form is `9376133`.

| Source | Role |
| --- | --- |
| `src/lib/cta/conversion-intent.ts` and `src/app/(content)/skills/_components/skills-newsletter-config.ts` | Define and re-export the Skills form id and conversion fields. |
| `src/app/(content)/skills/_components/skills-newsletter-actions.ts` | One-click entry. Previously, signed-in readers skipped DOI, subscribed directly in Kit and emitted the required Kit id. This is the branch changed here. Cookie-only readers retain DOI. |
| `src/app/api/coursebuilder/subscribe-to-list/convertkit/route.ts` | Posted form entry. Requests drovr DOI when configured; otherwise subscribes through Course Builder and emits the legacy entry event after consent checks. Unchanged. |
| `src/inngest/functions/optin-deferred-subscribe.ts` | Rechecks deferred legacy form/tag-me submissions, subscribes when allowed and emits the legacy Skills event. Existing queued work is unchanged. |
| `src/lib/subscriber-marketing/drovr-doi-signup.ts` and `.server.ts` | Map `9376133` to `skills-newsletter`, resolve or mint an owned contact, and queue a DOI request without Kit. Reused for non-confirmed evidence. |
| `src/lib/subscriber-marketing/drovr-list-subscribe.ts` | Existing confirmed-form mirror adapter. Recognises the Skills form. Not the new signed-in entry path. |
| `src/lib/subscriber-marketing/signup-confirmation-reconciler.server.ts` | Scans legacy Skills confirmations using `SKILLS_NEWSLETTER_FORM_ID`; emits legacy recovery events. Unchanged. |
| `src/lib/subscriber-marketing/signup-gap-recovery.ts` | Builds legacy replay/unstick events from recovered Kit records. Unchanged. |
| `src/scripts/subscriber-marketing-operator.ts` | Signup-gap, value-path and learner-flow operator defaults/reference commands use `9376133`. No operator or provider calls ran. |
| `src/env.mjs`, attribution modules, and tests | Configuration examples, attribution recording, timing/contract assertions and synthetic fixtures. These are not additional production form subscriptions. |

## Event consumers and drovr ingress

`src/inngest/events/skills-newsletter.ts` declares the event; `src/inngest/inngest.server.ts` registers both owned and legacy payloads. The only AI Hero Inngest subscriber is `src/inngest/functions/skills-newsletter-path-entry.ts`.

The legacy consumer calls `enterSkillsNewsletterSubscriber` in `src/lib/subscriber-marketing/skills-newsletter-path-entry.ts`. It uses the Kit id for capture identity and event keys, owner assignment, legacy Email 0 candidate metadata, shadow-newsletter identity and old-sequence request identity. That path remains intact for existing legacy events. The owned payload now takes an early branch through `owned-skills-enrolment.ts`, before any legacy planner, shadow admission or old-sequence request.

The old failure path was: signed-in action → Kit form `9376133` → `skills-newsletter/subscribed` with Kit id → legacy path entry → unowned `value-path.entered` → Kit drip. The owned path is: signed-in action → confirmed Skills consent → event with `contactId` → owner decision/assignment → existing authority birth → owned `value-path.entered`. `value-path-drip-progression.ts` reports `deferred / drovr-owned` for that contact.

Drovr does not consume the AI Hero subscribed event. Its existing ingress keys births by tenant and contact id; the value-path journey accepts `contact.created` and `contact.confirmed`. Relevant drovr sources: `packages/journey-value-path/src/machine.ts`, `confirmed-birth.test.ts`, `apps/api/test/team-enroll.test.ts`, `apps/api/src/confirm-tenants.ts`, and `apps/api/src/kit/README.md`. Kit alias binding stays with the existing directory/inbound path, not the birth payload. This PR introduces no drovr ingress contract.

## Rollout and rollback

Keep the new flag off for review and deployment. Before enabling it, verify that list-state returns a confirmed `skills-newsletter` form for an intended signed-in learner; profile-only confirmation is insufficient. Coordinate the owned gating flag so pages read the new owned access facts rather than legacy cookie fields. Keep the existing owner rollout configured for drovr admissions.

For a Kit-unreachable check, enable the new flag in an approved environment and disable mirror writes. Enrol a synthetic signed-in learner with confirmed Skills consent. Verify owned capture, exactly one course owner and an access fact, then verify the drip reports `drovr-owned`. Check that no legacy email intent, Kit-ref Skills capture, old-sequence request or shadow-newsletter assignment appears. Repeat for a returning learner and verify no restart. Unknown or stopped consent must request DOI or refuse, with no owner birth.

Watch `skills.owned-enrolment.result`, `skills.owned-enrolment.failed` and `skills.owned-enrolment.mirror-failed`. Rollback sets `AIH_ENROLMENT_OFF_KIT_ENABLED=false` to stop new admissions. Already queued owned events continue to interpret their contact ids correctly; existing owners and access are not removed. No production proof or flag change was performed by this PR.
