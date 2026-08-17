export const SKILLS_COURSE_FORM_ID = 9376133
export const SKILLS_COURSE_FIELDS = { interest: 'skills' } as const
export const SKILLS_COURSE_STARTED_AT_FIELD = 'aih_course_started_at'

export type ConversionIntent =
	| { kind: 'skills-course' }
	| { kind: 'cohort-waitlist'; productName: string }
	| { kind: 'workshop-interest'; workshopSlug: string }
	| { kind: 'newsletter' }

export type GenericKnownConversionIntent = Extract<
	ConversionIntent,
	{ kind: 'cohort-waitlist' } | { kind: 'newsletter' }
>

export type ConversionSurface =
	| 'skills-hero'
	| 'skills-subscribe'
	| 'skills-campaign'
	| 'skills-for-your-team'
	| 'homepage-course'
	| 'skills-post'
	| 'homepage-cohort'
	| 'courses-cohort'
	| 'cohort-page'
	| 'workshop-page'
	| 'post-closing'
	| 'list-closing'
	| 'video-block'

export type ConversionIntentContract = {
	/** Stable identity used in logs, events, idempotency, and tests. */
	key: string
	/** Undefined means the site's default Kit form. */
	formId: number | undefined
	/** The canonical completion facts written on every path into this intent. */
	fields: Record<string, string>
	/** A derived Kit projection. The field remains the canonical completion fact. */
	tagName: string | null
}

export type ConversionSubscriber = {
	state?: string | null
	fields?: Record<string, unknown> | null
}

export type ConversionPlan =
	| { mode: 'hidden'; reason: 'completed' }
	| { mode: 'form' }
	| { mode: 'one-click' }

type FieldBackedConversionIntent = Exclude<
	ConversionIntent,
	{ kind: 'skills-course' } | { kind: 'newsletter' }
>

/**
 * Make the browser's subscriber snapshot reflect a write Kit accepted.
 *
 * Kit's subscribe response is not guaranteed to echo custom fields
 * immediately. Saving that response verbatim creates a particularly sticky
 * failure: the year-long subscriber cookie says the intent is incomplete, and
 * every CTA trusts that cookie before asking Kit. The remote write succeeded,
 * but the site keeps asking the reader to do it again.
 *
 * The fields passed here are the exact fields sent through a provider contract
 * that creates and writes missing custom fields before it resolves. Never call
 * this after enqueueing a background write; an accepted queue event is not Kit
 * confirmation.
 */
export function withConfirmedConversionFields<
	T extends { fields?: Record<string, unknown> | null },
>(subscriber: T, fields: Record<string, string>): T {
	return {
		...subscriber,
		fields: {
			...(subscriber.fields ?? {}),
			...fields,
		},
	}
}

/**
 * The marketing contract for an intent.
 *
 * Callers choose the thing and where it is rendered. They cannot choose its
 * Kit form, completion field, tag, or attribution source independently. That
 * is the seam: adding another surface cannot create a subscriber who reached
 * the confirmation page without the state that the rest of the site gates on.
 */
export function conversionIntentContract({
	intent,
	surface,
	now = new Date(),
}: {
	intent: ConversionIntent
	surface: ConversionSurface
	now?: Date
}): ConversionIntentContract {
	if (intent.kind === 'skills-course') {
		return {
			key: 'course:skills',
			formId: SKILLS_COURSE_FORM_ID,
			fields: {
				...SKILLS_COURSE_FIELDS,
				source: sourceForSurface(surface),
			},
			tagName: null,
		}
	}

	if (intent.kind === 'newsletter') {
		// The plain email-list ask. No completion field of its own — being on
		// the list IS the completion, so gating reads `state` alone — and no
		// tag: the list membership is the whole projection.
		return {
			key: 'newsletter',
			formId: undefined,
			fields: {
				source: sourceForSurface(surface),
			},
			tagName: null,
		}
	}

	if (intent.kind === 'cohort-waitlist') {
		const marketingKey = normalizeMarketingKey(intent.productName)
		const waitlistKey = conversionFieldKey(intent)
		return {
			key: `waitlist:cohort:${marketingKey}`,
			formId: undefined,
			fields: {
				[waitlistKey]: isoDate(now),
				source: sourceForSurface(surface),
			},
			tagName: waitlistKey,
		}
	}

	const marketingKey = normalizeMarketingKey(intent.workshopSlug)
	const interestKey = conversionFieldKey(intent)
	return {
		key: `interest:workshop:${marketingKey}`,
		formId: undefined,
		fields: {
			[interestKey]: isoDate(now),
			source: sourceForSurface(surface),
		},
		tagName: interestKey,
	}
}

export function hasCompletedConversionIntent(
	intent: ConversionIntent,
	subscriber: ConversionSubscriber | null | undefined,
): boolean {
	// A field on an inactive/cancelled record is not a completed opt-in. Those
	// readers still need the one-click/resubscribe path rather than disappearing
	// from the funnel forever.
	if (subscriber?.state !== 'active') return false

	if (intent.kind === 'skills-course') {
		const startedAt = subscriber.fields?.[SKILLS_COURSE_STARTED_AT_FIELD]
		return typeof startedAt === 'string' && startedAt.trim().length > 0
	}

	// An active subscriber is already on the list; the newsletter ask has no
	// further fact to check.
	if (intent.kind === 'newsletter') return true

	const key = conversionFieldKey(intent)
	const value = subscriber.fields?.[key]
	return typeof value === 'string' && value.trim().length > 0
}

export function planConversionIntent({
	intent,
	knownIdentity,
	subscriber,
}: {
	intent: ConversionIntent
	knownIdentity: boolean
	subscriber: ConversionSubscriber | null | undefined
}): ConversionPlan {
	if (hasCompletedConversionIntent(intent, subscriber)) {
		return { mode: 'hidden', reason: 'completed' }
	}
	return knownIdentity ? { mode: 'one-click' } : { mode: 'form' }
}

export function normalizeMarketingKey(value: string): string {
	return value
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/[^a-zA-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toLowerCase()
}

function conversionFieldKey(intent: FieldBackedConversionIntent): string {
	return intent.kind === 'cohort-waitlist'
		? `waitlist_${normalizeMarketingKey(intent.productName)}`
		: `interest_${normalizeMarketingKey(intent.workshopSlug)}`
}

function isoDate(now: Date): string {
	return now.toISOString().slice(0, 10)
}

function sourceForSurface(surface: ConversionSurface): string {
	switch (surface) {
		case 'skills-hero':
			return 'aihero_skills_hero'
		case 'skills-subscribe':
			return 'aihero_skills_page'
		case 'skills-campaign':
			return 'aihero_campaign_ai_skills'
		// The team page. Same intent and the same Kit field as the workshop's own
		// waitlist — these are one list — but a distinct source, because "asked
		// from the page they were sent by a colleague" is the segment the launch
		// email is written for.
		case 'skills-for-your-team':
			return 'aihero_skills_for_your_team'
		case 'homepage-course':
			return 'aihero_homepage'
		case 'skills-post':
			return 'aihero_skills_post'
		case 'homepage-cohort':
			return 'aihero_homepage_cohort'
		case 'courses-cohort':
			return 'aihero_courses_cohort'
		case 'cohort-page':
			return 'aihero_cohort_page'
		case 'workshop-page':
			return 'aihero_workshop'
		case 'post-closing':
			return 'aihero_post_closing'
		case 'list-closing':
			return 'aihero_list_closing'
		case 'video-block':
			return 'aihero_video_block'
	}
}
