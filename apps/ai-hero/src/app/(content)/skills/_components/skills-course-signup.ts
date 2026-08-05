import { redirectUrlBuilder } from '@/convertkit'
import type { Subscriber } from '@/schemas/subscriber'

import { SKILLS_HOSTED_RESUBSCRIBE_URL } from './skills-newsletter-config'

/**
 * Where a successful course-form submission sends the reader. Every CTA that
 * enrols in the free course must go through here, because both branches are
 * easy to get wrong from memory:
 *
 * - An inactive Kit subscriber cannot be re-enrolled by the form alone — they
 *   have to go through Kit's hosted resubscribe flow, or nothing arrives.
 * - An active one goes to `/confirm?flow=course`. The `flow` param is what
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
	if (subscriber.state !== 'active') {
		window.location.assign(SKILLS_HOSTED_RESUBSCRIBE_URL)
		return
	}
	onEnrolled?.()
	router.push(redirectUrlBuilder(subscriber, '/confirm', { flow: 'course' }))
}
