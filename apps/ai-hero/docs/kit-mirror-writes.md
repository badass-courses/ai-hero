# Optional Kit mirror writes

`AIH_KIT_MIRROR_WRITES_ENABLED` defaults to **on**. An unset, empty or unrecognized value preserves existing writes. `false`, `off` and `0` disable them (case-insensitive, surrounding spaces ignored).

This is a compatibility switch, not a migration or an enrolment switch. No deployment environment value changes with this code. Keep it on until Kit automation, sequence and broadcast readers no longer need the projections.

## Coverage and owned facts

| Family | Kit projection stopped when off | Existing drovr coverage |
| --- | --- | --- |
| Purchase and seat redemption | `purchased_<product>_on`, fallback `purchased_on`, canonical `purchased_ai_coding_crash_course_on`, purchaser tag `22490749` | `purchase.recorded` carries product and purchase time. The separate purchase capture workflow remains unchanged. Checkout product events remain unchanged. |
| Purchase resync and operator backfill | Same purchase fields and purchaser tag | Existing purchase facts cover purchases already captured. These repair tools do not create a new drovr fact. |
| Team operator projection | `aih_team_role`, `aih_team_ids`, `aih_team_latest_team_id`, `aih_team_seat_count`, `aih_team_used_seat_count`, `aih_team_latest_product`, `aih_team_latest_purchase_at`; `AIH Team Owner` and `AIH Team Member` tags | **Partial:** purchase facts remain, but no equivalent fact for this full team/seat-count snapshot was found. The switch does not add one. Owned purchase rows and team fulfilment remain unchanged. |
| Value-path finisher | `aih_finisher_segment`, `aih_next_course_waitlist_at` | **Partial:** the local `value-path.answer-selected` event and completed intent remain. The existing drovr answer fact carries the email resource ID, not the exact finisher segment or waitlist date. No new contract is added. |
| Skills | Course-entry time-zone field stash; shadow newsletter sequence `2625552` and fallback tag `22309615` | Entry event, time-zone evidence, local capture and existing drovr birth/ownership processing remain. The legacy enrolment request record remains. |
| Interest | Workshop interest field/tag and CTA waitlist/interest field/tag projections | Existing `interest.expressed` facts remain under their existing facts flag. The master switch does not enable that flag. One-click actions fail rather than fall back to Kit when no owned join can queue. |
| Coupon | `aih_evergreen_deadline_display`, `aih_evergreen_deadline_short`, `aih_evergreen_discount_amount`, `aih_evergreen_offer_price`, `aih_evergreen_offer_url`, `aih_evergreen_regular_price` | Existing coupon issue/completion and dispatch remain; field failure was already optional. A Kit pitch still fails closed without confirmed offer fields. |
| Survey / inventory's admin router writes | Survey answer, completion and last-surveyed fields; answer-driven form subscribe | Local question responses and the existing survey-interest fact scheduling remain. The master cut takes the existing survey-off-Kit path even if its family flag is off. |

## Explicit exceptions

- **Total TypeScript's account is unchanged.** Both its subscriber lookup and purchase-field write still run. The AI Hero switch does not own that account.
- **Skills form enrolment and consent stay on Kit.** Form `9376133` subscribes the learner and returns the Kit ID required by `SKILLS_NEWSLETTER_SUBSCRIBED_EVENT`. When the form matches `DROVR_DOI_FORMS`, a reader who is not signed in as the address requests drovr DOI and returns before the Kit subscribe. A signed-in reader bypasses that DOI branch and can still subscribe directly to Kit; returning-unsubscriber routing can also defer or request DOI before that subscribe. These are alternate branches, not two subscriptions in one request. The direct form's conversion fields remain part of its enrolment contract. Moving this to a drovr-owned identity contract is separate work. Therefore an entire skills signup is not a zero-Kit operation; its optional stash and shadow mirrors are.
- **Consent and suppression writes remain.** Turning them off while Kit still sends would let opted-out readers receive mail. This switch does not change preferences, unsubscribe reconciliation, or signup consent. General signup forms are not disabled; interest-only mirror fields are stripped by the existing interest cut.
- This switch is not a global Kit transport kill switch. Other Kit consumers outside this inventory keep their own gates.

## Fulfilment and failure isolation

`add-purchase-convertkit` is a separate event consumer from `post-purchase-workflow`, `team-purchase-fulfillment`, and `capture-purchase-contact-event`. A failing AI Hero Kit call can fail and retry the mirror workflow, but fulfilment and purchase capture do not await it. This was already true before this switch. The purchase mirror retains that retry behavior when on. When off, it skips AI Hero's lookup as well as writes, loads the same purchase, and continues the unchanged Total TypeScript projection.

Tests exercise a rejected Kit lookup followed by the real team-fulfilment handler, master-off purchase/TT behavior, and fulfilment, `purchase.recorded`, and product-event contracts with the master off. Tests use mocks and synthetic fixtures, never live Kit or payment calls.

Finisher writes report `mirror-disabled` instead of pretending a Kit write happened. Their local intent completes once; dry-run remains dry-run. Team and operator backfill summaries also report `mirror-disabled`.

## Rollout and rollback

1. Deploy with the flag absent, preserving existing behavior.
2. Verify all remaining Kit readers and the coverage gaps above before authorizing a flag change. In particular, keep the existing interest facts path available before cutting interest mirrors.
3. After an authorized cut, check mirror calls per family, purchase capture, entitlements, team linkage, and drovr product facts. Consent and TT calls are expected exceptions, not mirror leaks.
4. To restore projections, set the flag to `true` or remove it. Skipped historical writes are not automatically replayed; use the existing purchase/team repair tools only with separate approval. Rolling back the code also restores default-on behavior.
