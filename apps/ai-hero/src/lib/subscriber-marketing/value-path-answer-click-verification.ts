/**
 * Plausibility checks for /ask answer clicks.
 *
 * Email security scanners follow every link in an email, so a scanned
 * contact accumulates answer-selected events far beyond anything a human
 * produces (observed 18-30 per contact in the 2026-05 cohort) and clicks
 * several different options for the same email step. The course delivers at
 * most fourteen emails across both branches, so organic volume can never
 * exceed one selection per email plus a little slack. Clicks past these
 * ceilings are treated as unverified: they must not advance progression and
 * must not park the daily drip.
 */
export const MAX_PLAUSIBLE_ANSWER_CLICKS_PER_CONTACT = 14
export const MAX_PLAUSIBLE_ANSWER_CLICKS_PER_STEP = 2

export type AnswerClickEventLike = {
	occurredAt: string
	payloadSummary?: { summary?: unknown } | null
}

export type AnswerClickVerification<T extends AnswerClickEventLike> =
	| { verdict: 'none' }
	| { verdict: 'verified'; event: T }
	| { verdict: 'implausible-contact-volume' }
	| { verdict: 'implausible-step-volume' }

export function isPlausibleAnswerClickVolume(events: readonly unknown[]) {
	return events.length <= MAX_PLAUSIBLE_ANSWER_CLICKS_PER_CONTACT
}

export function verifyAnswerClickForStep<T extends AnswerClickEventLike>(args: {
	events: readonly T[]
	emailStepId: string
	completedAt?: string
}): AnswerClickVerification<T> {
	if (!isPlausibleAnswerClickVolume(args.events)) {
		return { verdict: 'implausible-contact-volume' }
	}
	const completedAt = args.completedAt ? new Date(args.completedAt) : undefined
	const stepEvents = args.events.filter((event) => {
		if (completedAt && new Date(event.occurredAt) < completedAt) return false
		const summary = event.payloadSummary?.summary
		return (
			typeof summary === 'string' && summary.includes(` for ${args.emailStepId}`)
		)
	})
	if (stepEvents.length === 0) return { verdict: 'none' }
	if (stepEvents.length > MAX_PLAUSIBLE_ANSWER_CLICKS_PER_STEP) {
		return { verdict: 'implausible-step-volume' }
	}
	const event = stepEvents[0]
	if (!event) return { verdict: 'none' }
	return { verdict: 'verified', event }
}
