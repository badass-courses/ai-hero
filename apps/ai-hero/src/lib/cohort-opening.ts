import type { UpcomingCohortSummary } from '@/lib/upcoming-cohort-query'
import { formatInTimeZone } from 'date-fns-tz'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * When enrollment opens, for a cohort that is announced but not on sale yet.
 *
 * A cohort moves through four stages a reader can tell apart: announced (it
 * has dates, seats are not on sale), open, on sale, and closed. The last three
 * were already resolved (`getUpcomingCohort`, `getCoursesHeroState`); the
 * first was not, so an announced cohort read like the gap between cohorts,
 * "dates to follow", while its dates sat in the data.
 *
 * Null in every other stage: no date set, or the date has passed. A caller can
 * read the result as "there is an opening date worth printing".
 */
export function upcomingEnrollmentOpening(
	cohort: Pick<UpcomingCohortSummary, 'opensAt'> | null,
	now: Date,
): Date | null {
	if (!cohort?.opensAt) return null
	const opens = new Date(cohort.opensAt)
	if (Number.isNaN(opens.getTime())) return null
	return opens.getTime() > now.getTime() ? opens : null
}

/**
 * How far off the opening is, then the exact moment in the cohort's own zone:
 * "in 13 days (Oct 26 at 12:01 AM PDT)". Every surface that says when
 * enrollment opens says it with this, after the words "Enrollment opens".
 *
 * The count leads because it is what a reader acts on; the timestamp alone
 * made them do the subtraction. The moment and its zone stay, in parentheses,
 * because readers are in every time zone and "Oct 26" is a different day for
 * some of them.
 *
 * Elapsed time rounded up, not calendar days, for the same reason: "tomorrow"
 * is true in one zone and false in another. Inside the last day it counts
 * hours. A date that has passed comes back without a count, so a caller that
 * prints it anyway still prints something true.
 */
export function formatOpensIn(opens: Date, timezone: string, now: Date): string {
	const sameYear =
		formatInTimeZone(opens, timezone, 'yyyy') ===
		formatInTimeZone(now, timezone, 'yyyy')
	const moment = formatInTimeZone(
		opens,
		timezone,
		sameYear ? "MMM d 'at' h:mm a zzz" : "MMM d, yyyy 'at' h:mm a zzz",
	)
	const ms = opens.getTime() - now.getTime()
	if (ms <= 0) return moment
	if (ms > DAY) return `in ${Math.ceil(ms / DAY)} days (${moment})`
	const hours = Math.ceil(ms / HOUR)
	return `in ${hours} ${hours === 1 ? 'hour' : 'hours'} (${moment})`
}
