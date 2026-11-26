import { redirectUrlBuilder } from '@/convertkit'
import type { Subscriber } from '@/schemas/subscriber'

/** The form route's answer for a drovr double opt-in signup. */
export const DOI_AWAITING_CONFIRMATION = 'awaiting-confirmation'

/**
 * Where a successful course-form submission sends the reader. Every CTA that
 * enrols in the free course must go through here, because both branches are
 * easy to get wrong from memory:
 *
 * - A pending drovr signup goes to the generic confirmation page. A raw
 *   inactive reply uses that page too, without passing a legacy Kit id.
 * - An active subscriber goes to `/confirm?flow=course`. The `flow` param is what
 *   keeps that page from promising "a confirmation link" — the course sends
 *   lesson one directly and no such email exists, so the generic copy strands
 *   the reader (support threads cnv_1oh8twdh, cnv_1ohy6w4l).
 *
 * `onEnrolled` runs only on the active path, before navigation — the slot for
 * tracking calls and query-cache updates that must land while the page is
 * still mounted.
 */
export function completeSkillsCourseSignup(
	subscriber: Subscriber | undefined,
	router: { push: (url: string) => void },
	onEnrolled?: () => void,
) {
	if (!subscriber) return
	// drovr double opt-in (DROVR_DOI_FORMS): nothing is in Kit yet, and the
	// plain /confirm page is the one that says "check your email to confirm".
	if (subscriber.state === DOI_AWAITING_CONFIRMATION) {
		router.push(redirectUrlBuilder(subscriber, '/confirm'))
		return
	}
	if (subscriber.state !== 'active') {
		router.push('/confirm')
		return
	}
	onEnrolled?.()
	router.push(redirectUrlBuilder(subscriber, '/confirm', { flow: 'course' }))
}
