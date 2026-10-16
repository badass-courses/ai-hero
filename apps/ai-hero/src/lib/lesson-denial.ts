/**
 * Why a viewer cannot open a lesson. Each reason has its own copy, because
 * "you need to be a member" is wrong for most of them.
 *
 * Order matters, first match wins:
 * 1. `pending-open`: the cohort has not opened (kept from the legacy copy).
 * 2. `signed-out`: nobody is signed in.
 * 3. `region-restricted`: a purchase exists but its country restriction
 *    withholds it.
 * 4. `team-seat-unclaimed`: the viewer bought a team pool (`read Team`) but
 *    holds no seat of their own.
 * 5. `no-purchase`: everything else.
 */
export type LessonDenialReason =
	| 'pending-open'
	| 'signed-out'
	| 'region-restricted'
	| 'team-seat-unclaimed'
	| 'no-purchase'

export function lessonDenialReason({
	signedIn,
	isRegionRestricted,
	isPendingOpenAccess,
	hasTeamPool,
}: {
	signedIn: boolean
	isRegionRestricted: boolean
	isPendingOpenAccess: boolean
	hasTeamPool: boolean
}): LessonDenialReason {
	if (isPendingOpenAccess) return 'pending-open'
	if (!signedIn) return 'signed-out'
	if (isRegionRestricted) return 'region-restricted'
	if (hasTeamPool) return 'team-seat-unclaimed'
	return 'no-purchase'
}

export const LESSON_DENIAL_COPY: Record<
	Exclude<LessonDenialReason, 'pending-open'>,
	string
> = {
	'signed-out': 'Sign in to access this lesson.',
	'region-restricted':
		'Your purchase has a regional restriction, so this lesson is not available on it. Contact support if you think that is wrong.',
	'team-seat-unclaimed':
		'You bought team seats but have not claimed one for yourself. Claim a seat from the team page to open this lesson.',
	'no-purchase': 'You need to be a member to access this lesson.',
}
