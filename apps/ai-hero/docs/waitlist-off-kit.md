# The posted signup form off Kit

With `AIH_WAITLIST_OFF_KIT_ENABLED=true`, `POST /api/coursebuilder/subscribe-to-list/convertkit` (row K02) makes no Kit form subscribe and no Kit field write. The flag defaults off. `waitlistOffKitEnabled` in `src/lib/cta/interest-facts.ts` is the only place that reads it. Flag off, the route behaves exactly as before.

## Behaviour, flag on

The consent rule: a waitlist or interest join records an interest fact and nothing else. It is never a list subscribe. drovr double opt-in runs only on an explicit newsletter ask.

| Post | Answer |
| --- | --- |
| Any `waitlist_<x>` or `interest_<x>` field with a value | Queues one interest fact per key. When the address has no local contact, mints one (below). Answers 200 `{ email_address, first_name, state: 'joined', fields: { <keys> } }`. No Kit call, no double opt-in. |
| The same, when the fact cannot queue (facts off, Inngest down) | 502 `Subscription could not be confirmed`. No Kit fallback. |
| A plain newsletter ask to a drovr form (`drovrSignupKitFormId`: the default form or 8447166 with only `source`, or a post naming 9376133) | drovr double opt-in (`requestDrovrDoiSignup`), whatever `DROVR_DOI_FORMS` says. Answers `awaiting-confirmation`, as the DOI path does today. |
| The same, without drovr's base URL and tenant key | 502. Never Kit. |
| Anything else: an unmapped form, or other fields with no join | 400 `Subscription was rejected`, the refusal an unmapped DOI form already gets. |

The flag also implies the interest cut (`interestKitWritesEnabled()` answers false). The cohort and workshop one-click paths then answer from the queued fact alone. After a fact-only join, the form's `finalizeAnonymousConversionIntent` never tags Kit, even when its re-queue fails.

### The contact a cold join lands on

Today a cold join gets its contact from the Kit subscribe. Without one, `interest-fact-record` would wait out its 7-day window (`no-contact / unresolved`) and lose the join. So `holdInterestJoinContact` (`src/lib/cta/interest-facts.server.ts`) runs after the fact is queued. A known address mints nothing. An unknown one gets an owned contact through `resolveInterestJoinContact` (`src/lib/cta/interest-facts-contact.ts`), on the same capture path `resolveDoiSignupContact` uses before a DOI signup confirms:

- provider identity `ai-hero` / `interest-email:<emailKey>`;
- one `interest.join-requested` ContactEvent.

The mint carries no consent: no `subscriber.confirm`, no form and no list fact. drovr hears of the contact only through the existing directory seed (`mapDrovrShadowFact`, `contact-created` → `directory:seed:<id>`, `lifecycle: 'provisional'`). That is the same seed an unconfirmed DOI signup gets. drovr's segment census counts only identified, consented contacts without an all-stop (`isSegmentCensusContact`, drovr `packages/segments/src/index.ts`). A failed mint is one `interest.join.contact.failed` log line, with field keys and no address, and the join still answers.

**Still open, for Joel:** does a waitlist-only contact get launch email? The mint does not decide it.

## Left in place

The brief asked to delete these dead tails only where the flag-off path doesn't need them. The flag-off path needs every one of them, so they stay:

- **K04**, the `stashFields` → `setKitSubscriberFields` calls on the route's Kit path for form 9376133. Flag off, a 9376133 post reaches it whenever `DROVR_DOI_FORMS` does not cover 9376133 for that address.
- **K05**, the Kit subscribe and course-entry-evidence field write in `skills-newsletter-actions.ts`. They run for a cookie-only reader when DOI is off for 9376133, and for a signed-in reader when `AIH_ENROLMENT_OFF_KIT_ENABLED` is off.
- **I07**, `SKILLS_HOSTED_RESUBSCRIBE_URL`. K05's tail returns it, and `skills-newsletter-cta.tsx`, `skills-course-signup.ts` and `skills-course-restart-actions.ts` also read it.

They become deletable once 9376133 is hard-wired to DOI and the enrolment flag is retired, as #648 did for its flags.

## Live-key facts: why drovr has none

drovr has no facts for `waitlist_software_factories_for_real_engineers` or `interest_ai_coding_crash_course`. This is not a code fault. Neither key has a live join surface. `CrashCourseCta` renders `TeamWaitlist` only while the crash-course workshop is not published and public, and the C5 cohort page and hero show a buy link during the sale. Every join path still in place (this route, the one-click cohort action, the one-click workshop action) queues the fact before Kit. The ~4.9k Kit holders per key joined before facts shipped (#597, 2026-10-29), and nothing has backfilled Kit fields into facts: `via: 'backfill'` is typed but has no producer. Also, `interest.fact.recorded` logs only when a run ends, so a join waiting on an unconfirmed contact (up to 7 days) does not appear in a shorter Axiom window.

## Flip, verification and rollback

Flip only after Joel rules on who gets launch emails, and not before C5 closes on 2026-11-10 unless he says so.

1. Confirm `AIH_INTEREST_FACTS_ENABLED=true` and drovr's base URL and `DROVR_API_KEY_ORG_AIHERO` in Production.
2. Settle the `/confirm` copy first. `WaitlistForm` sends a form join to `/confirm`, which says a confirmation email was sent. `TeamWaitlist` with `confirmInPlace` says "click the confirmation link". After a fact-only join, no email goes out. This is a customer-facing copy change, so it needs Matt's heads-up.
3. Set `AIH_WAITLIST_OFF_KIT_ENABLED=true` in Production (`printf 'true' | vercel env add …`) and redeploy.
4. Verify with a synthetic `*@example.test` address on a waitlist surface. The response should be `state: 'joined'`. Axiom should show `interest.join.contact.minted` and, later, `interest.fact.recorded` with `local: inserted`. There should be no `kit.subscribe.*`, and drovr should hold the fact for that role. A plain newsletter ask should show `skills.newsletter.doi.requested`. Watch `interest.join.contact.failed` and `interest.fact.enqueue.failed`.
5. Rollback: unset the flag or set it to anything but `true`, then redeploy. Facts and contacts already recorded stay; nothing is undone.
