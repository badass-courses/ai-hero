/**
 * What a library entry is, and the rules for deciding what it says.
 *
 * Split from `./library-query` the same way `./cohort-navigation` is split from
 * its query module: that file reaches the database and the session, which makes
 * it unimportable from a test or a client component. These decisions are the
 * part worth testing, so they live where they can be.
 */

export type LibraryEntry = {
	key: string
	title: string
	/** The cohort a workshop sits in, when the entry is one workshop of one. */
	contextLabel: string | null
	/** The overview: the cohort or workshop page. */
	href: string
	/**
	 * Where the learner actually wants to go. Never absent: a card with no
	 * action is the dead end this page exists to remove, so an entry with no
	 * lesson to point at falls back to its overview.
	 */
	cta: { label: string; href: string }
	completedLessons: number
	totalLessons: number
	percent: number
	status: 'not-started' | 'in-progress' | 'complete'
	purchasedAt: Date | null
}

export function statusFor(
	completed: number,
	total: number,
): LibraryEntry['status'] {
	if (total > 0 && completed >= total) return 'complete'
	return completed > 0 ? 'in-progress' : 'not-started'
}

/**
 * "Continue: Permissions" beats "Continue" — name the thing you get.
 *
 * Never returns null. A card with no action at all is the dead end this page
 * exists to remove, so when there is no lesson to point at — a cohort whose
 * workshops have not dropped, a workshop with no lessons yet — it falls back
 * to the overview.
 */
export function ctaFor(
	status: LibraryEntry['status'],
	lessonTitle: string | null,
	lessonHref: string | null,
	overviewHref: string,
): LibraryEntry['cta'] {
	if (status === 'complete') return { label: 'Review', href: overviewHref }
	if (!lessonHref) return { label: 'View course', href: overviewHref }

	const verb = status === 'not-started' ? 'Start' : 'Continue'
	return {
		label: lessonTitle ? `${verb}: ${lessonTitle}` : verb,
		href: lessonHref,
	}
}

type WorkshopProgress = {
	workshop: { slug: string; title: string; state: string; startsAt: string | null }
	progress: {
		completedLessonsCount?: number
		totalLessonsCount?: number
	} | null
}

/**
 * The workshop a cohort's CTA should point into: the first released one that
 * still has an unfinished lesson.
 *
 * Counts lessons rather than reading `percentCompleted`, which the progress
 * adapter rounds UP (`Math.ceil`) — at 199 of 200 lessons it already reports
 * 100, which would skip the workshop holding the learner's actual next lesson
 * and leave the card pointing at nothing.
 *
 * Skipping unreleased workshops matters too: their progress is 0/0, so without
 * that check a cohort mid-drop would always point at the one that has not
 * landed yet.
 */
export function pickCurrentWorkshop<T extends WorkshopProgress>(
	progressByWorkshop: T[],
	isAvailable: (workshop: T['workshop']) => boolean,
): T | undefined {
	return progressByWorkshop.find(({ workshop, progress }) => {
		const total = progress?.totalLessonsCount ?? 0
		const completed = progress?.completedLessonsCount ?? 0
		return isAvailable(workshop) && total > 0 && completed < total
	})
}

