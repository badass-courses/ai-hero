/**
 * Why a viewer cannot open a lesson. Each reason has its own copy, because
 * "you need to be a member" is wrong for most of them.
 *
 * Order matters, first match wins:
 * 1. `pending-open`: the cohort has not opened (kept from the legacy copy).
 * 2. `signed-out`: nobody is signed in.
 * 3. `region-restricted`: a purchase exists but its country restriction
 *    withholds it.
 * 4. `no-purchase`: everything else.
 *
 * There is deliberately no "team seat unclaimed" reason. The ability's
 * `read Team` is true for a bulk purchase of ANY product, so it cannot tell a
 * pool for this lesson from a pool for another course, and sending someone to
 * burn a seat on the wrong product is worse than generic copy. It returns
 * once the pool is scoped to a product that grants this lesson's resource.
 */
export type LessonDenialReason =
	| 'pending-open'
	| 'signed-out'
	| 'region-restricted'
	| 'no-purchase'

export function lessonDenialReason({
	signedIn,
	isRegionRestricted,
	isPendingOpenAccess,
}: {
	signedIn: boolean
	isRegionRestricted: boolean
	isPendingOpenAccess: boolean
}): LessonDenialReason {
	if (isPendingOpenAccess) return 'pending-open'
	if (!signedIn) return 'signed-out'
	if (isRegionRestricted) return 'region-restricted'
	return 'no-purchase'
}

export const LESSON_DENIAL_COPY: Record<
	Exclude<LessonDenialReason, 'pending-open'>,
	string
> = {
	'signed-out': 'Sign in to access this lesson.',
	'region-restricted':
		"A regional restriction applies to this purchase, so this lesson isn't available. Contact support if you think that is wrong.",
	'no-purchase': 'You need to be a member to access this lesson.',
}

/**
 * The reasons that travel across the redirect to the module page, as
 * `?denied=<reason>`. A whitelist: anything else is ignored, so the query
 * string can never put text on the page. `pending-open` is left out because
 * the module page already shows the start date.
 */
export const DENIED_QUERY_REASONS = [
	'signed-out',
	'region-restricted',
	'no-purchase',
] as const
export type DeniedQueryReason = (typeof DENIED_QUERY_REASONS)[number]

export function parseDeniedReason(
	value: string | null | undefined,
): DeniedQueryReason | null {
	return DENIED_QUERY_REASONS.find((reason) => reason === value) ?? null
}

export function deniedRedirectPath(
	moduleSlug: string,
	reason: LessonDenialReason,
): string {
	const base = `/workshops/${moduleSlug}`
	return reason === 'pending-open'
		? base
		: `${base}?denied=${encodeURIComponent(reason)}`
}
