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

/**
 * The overview page for a purchased resource.
 *
 * `/{slug}` is only right for a post — a cohort or workshop sent there 404s, so
 * the fallback entry this builds would be its own dead end.
 *
 * @param resourceType - The content resource's type, or null when unknown.
 * @param slug - The resource's routing slug, or null when it has none.
 * @returns A path, defaulting to the workshops index when there is no slug.
 */
export function overviewHrefFor(
	resourceType: string | null,
	slug: string | null,
): string {
	if (!slug) return '/workshops'
	if (resourceType === 'cohort') return `/cohorts/${slug}`
	if (resourceType === 'workshop' || resourceType === 'tutorial') {
		return `/workshops/${slug}`
	}
	return `/${slug}`
}

/**
 * How far through a course someone is, from lesson counts alone.
 *
 * Counts rather than a percentage, because the progress adapter rounds its
 * `percentCompleted` up — see `pickCurrentWorkshop`.
 *
 * @param completed - Lessons with recorded progress.
 * @param total - Lessons in the course. Zero for something with no lessons yet,
 *   which reads as `not-started` rather than `complete`: nothing has been
 *   finished, there is simply nothing to finish.
 * @returns `complete` once every lesson is done, `in-progress` after the first,
 *   `not-started` otherwise.
 */
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

/**
 * Where an in-progress learner was last, when that beats "first unfinished".
 *
 * The player saves a playback position on the lesson's progress row before the
 * lesson is completed, so the most recently touched lesson is often one they
 * are halfway through. That is where Continue should land. Once that lesson is
 * completed the answer is the next unfinished one, which `ctaFor` already has.
 *
 * @param latest - The most recently touched lesson, from `getLatestCourseLesson`.
 * @param progress - The learner's progress rows.
 * @returns A Continue CTA, or null when the latest lesson is already finished.
 */
export function resumeCtaFor(
	latest: {
		lesson: { id: string; fields?: Record<string, unknown> | null }
		href: string
	} | null,
	progress: { resourceId?: string | null; completedAt?: Date | null }[],
): LibraryEntry['cta'] | null {
	if (!latest) return null

	const finished = progress.some(
		(row) => row.resourceId === latest.lesson.id && row.completedAt,
	)
	if (finished) return null

	const title = latest.lesson.fields?.title
	return {
		label:
			typeof title === 'string' && title ? `Continue: ${title}` : 'Continue',
		href: latest.href,
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

