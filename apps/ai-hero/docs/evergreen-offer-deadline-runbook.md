# Evergreen offer deadline

The evergreen Crash Course offer (drovr's value-path journey, pitch emails P1–P5 in Kit) promises a deadline: the coupon's `expires`. AI Hero renders that deadline once, when the coupon is issued, into Kit fields that the pitch emails print (row 183). Code: `src/lib/subscriber-marketing/offer-deadline.ts` and `drovr-evergreen-coupon.ts`.

## The Kit fields

Written by the coupon issuer (`executePendingEvergreenCoupons`), all at once, **before** the row completes and `coupon.issued` goes to drovr. A failed field write retries or fails the row, so no pitch starts on a contact without them.

| field | printed by | written |
|---|---|---|
| `aih_evergreen_offer_url` | P1–P5 | always |
| `aih_evergreen_offer_price` | P1–P5 | always |
| `aih_evergreen_regular_price` | P1–P5 | always |
| `aih_evergreen_discount_amount` | P1, P3 | always |
| `aih_evergreen_deadline_display` | P1–P5 | always, in the format below |
| `aih_evergreen_deadline_short` | P5's preview text, once it's edited | **only with V2 on** |

- None of them has a Liquid default in the emails. A field with no value prints nothing (not raw `{{ }}`).
- The values are the coupon's, fixed at issue. Changing a flag or an email doesn't rewrite fields already written.

## The flags

- **`AIH_EVERGREEN_DEADLINE_FORMAT_V2_ENABLED`** (on only when exactly `true`), read at coupon issue:
  - **on:** `deadline_display` is the absolute format with the UTC equivalent (`formatOfferDeadline`), and `deadline_short` is written too;
  - **off (legacy):** `deadline_display` is the old long format in the pinned zone, and `deadline_short` is **not written**. It isn't cleared either, so a contact keeps whatever an earlier V2 coupon left there.
- **`AIH_DEADLINE_TIMEZONE_CAPTURE_ENABLED`** (`true`): captures the learner's zone (`x-vercel-ip-timezone`) at signup, so a new birth pins their zone. Off, every birth pins the Pacific fallback.
  - **Exhaustion on means capture on too.** `AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED` doesn't turn capture on. Whoever sets it to `true` in production must also set `AIH_DEADLINE_TIMEZONE_CAPTURE_ENABLED=true`, after its own preflight (`pnpm kit:fields:check aih_course_entry_evidence` shows `yes`).

## Rule: rolling V2 back reverts P5's preview in the same step

P5's preview text is planned to read `Ends {{ subscriber.aih_evergreen_deadline_short }}`. Legacy never writes that field, so with V2 off, every coupon issued afterwards gets a P5 whose preview reads "Ends " with nothing after it (or an older V2 coupon's date).

So **whoever sets `AIH_EVERGREEN_DEADLINE_FORMAT_V2_ENABLED` to anything but `true` must, in the same step, set P5's preview back to static text**: the rollback of record's "This is the last email about this offer.". P5 is Kit sequence 2887686, email 10317238.

- The headline (`Your private offer ends {{ subscriber.aih_evergreen_deadline_display }}`) needs nothing: legacy writes `deadline_display` too.
- Until the preview edit is saved, P5's preview is static text, and a V2 rollback needs no Kit change.
- Check it after any flip, before the next coupon issue: preview P5 in Kit as a subscriber from the newest cohort, and read back `preview_text` through the Kit API.

## Kit email edits

- The Kit v4 API (`PUT /v4/sequences/{id}/emails/{id}`) changes the subject and the preview text, **not the body**. A PUT without `preview_text` cleared it once. Read the email back after any PUT.
- Body edits (the headline) go through the Kit editor.
- Save a rollback first: `GET` the email to a file.
