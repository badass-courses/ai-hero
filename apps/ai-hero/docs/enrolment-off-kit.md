# Owned Skills enrolment

`AIH_ENROLMENT_OFF_KIT_ENABLED=true` moves the signed-in Skills action onto owned identity, stop reads and the existing course-owner birth. It defaults off. No environment values change in this PR.

## Behaviour

- `tagSubscriberAsSkills` verifies that the reader is signed in as the server-resolved address. The service checks the matching session again. A cookie alone does not qualify.
- Resolve the contact through the owned email directory. A miss mints through owned capture; ambiguous identity refuses without a Kit lookup.
- The login-verified address plus this explicit click grants course consent. `confirmed` (including profile evidence with `forms: []`), `unconfirmed`, and `unknown / no-consent-evidence` permit enrolment. A reliable `no-contact` reply also permits the owned contact to enter. A pre-existing confirmed Skills form is not required.
- An all-stop or `course:value-path-skills-course` stop takes the existing resubscribe/DOI path. It never enrols or lifts a stop silently.
- An unavailable, failed, malformed or timed-out read makes no consent decision: no enrolment and no DOI. The contact-id request stays durable in Inngest; the worker retries the stop read up to Inngest's `maxAttempts`, then fails visibly in Inngest/Axiom. The reader can click again. A queue failure refuses without falling back to Kit.
- The event carries `contactId`, the signed-in user id, time, source and a query-free page URL. Kit remains an optional compatibility alias on owned events; legacy producers retain their Kit-id contract.
- After a reliable admission read, the worker records an owned `skills-newsletter.subscribed` consent ContactEvent. Its provider is `ai-hero`, not Kit. The existing emitter maps that owned event to the existing contact-directory `contact.confirmed` fold, as Kit activation does. It confirms the profile, not a DOI/form-consent row; `forms[]` does not gain a fabricated confirmation.
- The worker uses the existing journey-owner decision and authority birth, then records the owned course-entry/access fact. It preserves timezone evidence and requests the existing profile sync. The legacy drip defers to the recorded owner.
- Existing owners remain sticky. Repeat clicks reuse the original course-entry evidence, including its timezone capture, and still request profile sync. An in-flight legacy course is not migrated or restarted. A hold or rollout decision that selects legacy refuses new owned entry rather than invoking the Kit planner.
- No old-sequence `2625552` request or shadow-newsletter birth runs on this branch. Course enrolment does not grant newsletter consent.
- Kit form `9376133` is only an optional projection after owned entry, behind `AIH_KIT_MIRROR_WRITES_ENABLED`. It rechecks both drovr admission and local unsubscribe, bounce and complaint evidence. It skips on any active stop or read failure and cannot undo enrolment on failure. Set the mirror switch to `false` for zero form writes. Existing default-on switch semantics stay unchanged.
- Signed-out and cookie-only readers retain their existing behaviour. Keep `9376133` in `DROVR_DOI_FORMS` for a complete Kit-free funnel.

## Caller inventory

Search: `grep -rn '5470956\|9376133' apps/ai-hero/src`, then follow `SKILLS_COURSE_FORM_ID`, `SKILLS_FORM_ID` and `SKILLS_NEWSLETTER_SUBSCRIBED_EVENT`.

There are no callers or literals for `5470956` on base `03014872`. The active Skills form is `9376133`.

| Source | Role |
| --- | --- |
| `src/lib/cta/conversion-intent.ts` and `src/app/(content)/skills/_components/skills-newsletter-config.ts` | Define and re-export the Skills form id and conversion fields. |
| `src/app/(content)/skills/_components/skills-newsletter-actions.ts` | One-click entry. Previously, signed-in readers skipped DOI, subscribed directly in Kit and emitted the required Kit id. This is the changed branch. Cookie-only readers retain DOI. |
| `src/app/api/coursebuilder/subscribe-to-list/convertkit/route.ts` | Posted form entry. Requests drovr DOI when configured; otherwise subscribes through Course Builder and emits the legacy entry event after consent checks. Unchanged. |
| `src/inngest/functions/optin-deferred-subscribe.ts` | Rechecks deferred legacy form/tag-me submissions, subscribes when allowed and emits the legacy Skills event. Existing queued work is unchanged. |
| `src/lib/subscriber-marketing/drovr-doi-signup.ts` and `.server.ts` | Map `9376133` to `skills-newsletter`, resolve or mint an owned contact, and queue DOI without Kit. Reused for stopped readers. |
| `src/lib/subscriber-marketing/drovr-list-subscribe.ts` | Existing confirmed-form mirror adapter. Recognises the Skills form. Not the new signed-in entry path. |
| `src/lib/subscriber-marketing/signup-confirmation-reconciler.server.ts` | Scans legacy Skills confirmations using `SKILLS_NEWSLETTER_FORM_ID`; emits legacy recovery events. Unchanged. Unlike the signed-in click, a reconciler has no new reader action granting consent. |
| `src/lib/subscriber-marketing/signup-gap-recovery.ts` | Builds legacy replay/unstick events from recovered Kit records. Unchanged. |
| `src/scripts/subscriber-marketing-operator.ts` | Signup-gap, value-path and learner-flow operator defaults/reference commands use `9376133`. No operator or provider calls ran. |
| `src/env.mjs`, attribution modules, and tests | Configuration examples, attribution recording and synthetic fixtures. These are not additional production form subscriptions. |

## Event consumers and drovr ingress

`src/inngest/events/skills-newsletter.ts` declares the event; `src/inngest/inngest.server.ts` registers owned and legacy payloads. The only AI Hero Inngest subscriber is `src/inngest/functions/skills-newsletter-path-entry.ts`.

The legacy consumer calls `enterSkillsNewsletterSubscriber` in `src/lib/subscriber-marketing/skills-newsletter-path-entry.ts`. It uses the Kit id for capture identity/event keys, owner assignment, legacy Email 0 candidate metadata, shadow-newsletter identity and old-sequence request identity. This remains intact for legacy events. Owned payloads take an early branch through `owned-skills-enrolment.ts`, before any legacy planner, shadow admission or old-sequence request.

Old path: signed-in action → Kit form `9376133` → Kit-id event → legacy path entry → unowned `value-path.entered` → Kit drip. Owned path: signed-in action → owned identity and reliable stop read → contact-id request → owned consent/directory confirmation → owner decision/assignment and authority birth → owned `value-path.entered`. `value-path-drip-progression.ts` reports `deferred / drovr-owned` for that contact.

Drovr does not consume the AI Hero subscribed event directly. Existing ingress keys births by tenant/contact id. The value-path journey accepts `contact.created` and `contact.confirmed`. Directory confirmation uses the existing `contact.confirmed` exception for the `contact-directory` journey; it can birth an unseeded directory and uses the event time. Sources: `packages/journey-value-path/src/machine.ts`, `confirmed-birth.test.ts`, `packages/journey-contact-directory/src/machine.ts`, `apps/api/src/events.ts`, `apps/api/src/kit/fold.ts`, `apps/api/src/contact-list-state.ts`, `apps/api/src/confirm-tenants.ts` and `apps/api/src/kit/README.md`. Kit alias binding stays in the existing directory/inbound path, not the birth payload. This PR adds no drovr ingress contract or no-DOI form-confirmation API.

## Rollout and rollback

Keep the new flag off for review and deployment. Verify a reliable list-state read before rollout: confirmed profile, unconfirmed, or no consent evidence may enrol after a signed-in click; stopped evidence must not. Unavailable must retry without enrolment or DOI. Coordinate the owned gating flag so pages read new owned access facts rather than legacy cookie fields. Keep the existing owner rollout configured for drovr admissions.

For a Kit-unreachable proof, enable the new flag in an approved environment and disable mirror writes. Enrol a synthetic signed-in learner. Verify the owned consent event, directory confirmation, one course owner and an access fact. Verify the actual drip reports `drovr-owned`. Check that no legacy email intent, Kit-ref Skills capture, old-sequence request or shadow-newsletter assignment appears. Repeat for a returning learner and verify no restart. Test all/course stops and unavailable reads separately.

Watch `skills.owned-enrolment.result`, `skills.owned-enrolment.failed` and `skills.owned-enrolment.mirror-failed`. Rollback sets `AIH_ENROLMENT_OFF_KIT_ENABLED=false` to stop new admissions. Already queued owned events keep their contact-id interpretation; existing owners/access are not removed. No production proof or flag change was performed by this PR.
