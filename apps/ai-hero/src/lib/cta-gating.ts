import { cohortWaitlistFieldKey } from '@/app/(content)/cohorts/[slug]/_components/cohort-interest-config'
import { workshopInterestFieldKey } from '@/app/(content)/workshops/_components/workshop-interest-config'
import type { OfferWaitlist } from '@/lib/next-offer'
import { hasCompletedConversionIntent } from '@/lib/cta/conversion-intent'
import type { Subscriber } from '@/schemas/subscriber'

/**
 * "Has this viewer already done the thing this CTA is asking for?"
 *
 * Every ask on the site is gated on one of these. They are pure predicates over
 * a {@link Subscriber} record so the SAME test runs on the server (where a
 * dynamic route can simply not render the CTA) and on the client (where a
 * statically rendered route has to hide it after hydration). A CTA that hides
 * itself server-side on one route and client-side on another must not be able
 * to disagree with itself about who has already subscribed.
 *
 * The field keys come from the modules that WRITE them rather than being
 * re-derived here. `waitlist_<product>` and `interest_<workshop>` are produced
 * by their own normalizers, and a second copy of that derivation would gate on
 * a key nobody ever writes — which fails silently, as a CTA that never hides.
 *
 * All of them take `null | undefined` because "we have not resolved a
 * subscriber" and "there is no subscriber" must land on the same answer: show
 * the ask. Guessing the other way hides an offer from someone who never took
 * it, and an ask a subscriber sees twice is a smaller failure than an offer a
 * stranger never sees at all.
 */
/**
 * The only two things gating reads.
 *
 * Structural rather than `Subscriber` so the wire can carry LESS than the full
 * record. `getCtaGatingPayload` sends `state` and the interest flags and nothing
 * else — the endpoint is public, and the full record carries an email address —
 * while server-side callers still pass a whole `Subscriber`, which satisfies
 * this shape. Both take the same code path through the predicates below, which
 * is the point of this file.
 */
export type CtaGatingSubscriber = {
	state?: string | null
	fields?: Record<string, unknown> | null
}

type MaybeSubscriber = CtaGatingSubscriber | null | undefined

/**
 * On the email list, confirmed.
 *
 * `state === 'active'` rather than a truthy record: Kit keeps `inactive`
 * (unconfirmed) and `cancelled` (unsubscribed) subscribers, and both of those
 * people SHOULD still be asked. Anything looser promotes someone who never
 * clicked the confirmation link past every newsletter ask on the site — and
 * they are precisely the person the ask still needs to reach.
 */
export function isOnEmailList(subscriber: MaybeSubscriber): boolean {
	return subscriber?.state === 'active'
}

/**
 * Enrolled in the free 7-day skills course.
 *
 * The course and the newsletter are one list with a field between them, so
 * being on the list is NOT being on the course. This is the test
 * `SkillsNewsletterCta` uses to choose between "subscribe", the one-click
 * "tag me" and rendering nothing.
 */
export function hasStartedFreeCourse(subscriber: MaybeSubscriber): boolean {
	return hasCompletedConversionIntent({ kind: 'skills-course' }, subscriber)
}

/**
 * Already on the waitlist for this specific cohort.
 *
 * Keyed by product NAME, matching what the cohort pricing widget writes when
 * the form is submitted. The stored value is the ISO date they joined, so any
 * non-empty string counts.
 */
export function isOnCohortWaitlist(
	subscriber: MaybeSubscriber,
	productName: string | null | undefined,
): boolean {
	if (!productName) return false
	return hasNonEmptyField(subscriber, cohortWaitlistFieldKey(productName))
}

/**
 * Already signed up for whatever waitlist this offer carries.
 *
 * The ladder in `next-offer` can hand back a cohort waitlist or a workshop
 * waitlist, and the two live under different Kit field keys off different
 * identifiers. This is the one call a CTA makes so it does not have to branch
 * on `kind` — and so adding a third kind of waitlist later changes this file
 * rather than every surface that draws an offer.
 *
 * An offer with no waitlist (a purchase, a sale) is never "already answered"
 * here; ownership is a separate question with a separate answer.
 */
export function hasJoinedOfferWaitlist(
	subscriber: MaybeSubscriber,
	waitlist: OfferWaitlist | undefined,
): boolean {
	if (!waitlist) return false
	return waitlist.kind === 'cohort'
		? isOnCohortWaitlist(subscriber, waitlist.productName)
		: hasWorkshopInterest(subscriber, waitlist.slug)
}

/** Already registered interest in this specific workshop. */
export function hasWorkshopInterest(
	subscriber: MaybeSubscriber,
	workshopSlug: string | null | undefined,
): boolean {
	if (!workshopSlug) return false
	return hasNonEmptyField(subscriber, workshopInterestFieldKey(workshopSlug))
}

/**
 * Kit returns cleared custom fields as `null`, and the subscriber cookie is
 * written through `deepOmitNull`, so a field can arrive as `null`, as absent,
 * or — when a form posted an empty value — as `''`. All three mean "not set".
 */
function hasNonEmptyField(subscriber: MaybeSubscriber, key: string): boolean {
	const value = subscriber?.fields?.[key]
	return typeof value === 'string' && value.trim().length > 0
}
