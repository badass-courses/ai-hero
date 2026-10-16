import { formatInTimeZone } from 'date-fns-tz'
import type { WorkshopSummary } from './get-workshop-availability'

export const REAL_ENGINEERS_COHORT_ID = 'cohort-xdy1m'

export interface CohortWelcomeDetails {
	title: string
	schedule: string
	workshops: WorkshopSummary[]
	crashCourseUrl?: string
}

/** Fail closed: only open, published, learner-visible workshops enter this email. */
export function buildCohortWelcomeDetails(
	cohort: {
		fields: {
			title?: string
			startsAt?: string | null
			endsAt?: string | null
		} | null
		resources?: Array<{
			position: number
			deletedAt?: unknown
			resource: {
				type: string
				deletedAt?: unknown
				fields?: Record<string, any> | null
			} | null
		}>
	},
	now = new Date(),
): CohortWelcomeDetails {
	const { title, startsAt, endsAt } = cohort.fields || {}
	// Missing dates must not turn into an invented launch promise.
	const validDate = (value?: string | null) =>
		Boolean(value && !Number.isNaN(new Date(value).getTime()))
	const format = (value: string, pattern: string) =>
		formatInTimeZone(value, 'America/Los_Angeles', pattern)
	let schedule = "We'll email you when each part opens."
	if (validDate(startsAt) && validDate(endsAt)) {
		const sameMonth =
			format(startsAt!, 'yyyy-MM') === format(endsAt!, 'yyyy-MM')
		const range = sameMonth
			? `${format(startsAt!, 'MMMM d')}–${format(endsAt!, 'd, yyyy')}`
			: `${format(startsAt!, 'MMMM d, yyyy')} to ${format(endsAt!, 'MMMM d, yyyy')}`
		schedule = `The cohort runs ${range}. We'll email you when each part opens.`
	} else if (validDate(startsAt)) {
		schedule = `The cohort starts ${format(startsAt!, 'MMMM d, yyyy')}. We'll email you when each part opens.`
	}
	return {
		title: title || 'AI Coding for Real Engineers',
		schedule,
		workshops: [...(cohort.resources || [])]
			.sort((a, b) => a.position - b.position)
			.filter(({ resource, deletedAt }) => {
				const fields = resource?.fields
				return (
					!deletedAt &&
					resource &&
					!resource.deletedAt &&
					resource.type === 'workshop' &&
					fields?.state === 'published' &&
					['public', 'unlisted'].includes(fields.visibility) &&
					typeof fields.title === 'string' &&
					!/archive/i.test(fields.title) &&
					typeof fields.slug === 'string' &&
					Boolean(fields.slug) &&
					(!fields.startsAt ||
						(validDate(fields.startsAt) && new Date(fields.startsAt) <= now))
				)
			})
			.map(({ resource }) => ({
				title: resource!.fields!.title,
				slug: resource!.fields!.slug,
			})),
	}
}

export function cohortWelcomeSubject(
	details: CohortWelcomeDetails,
	variant: 'individual' | 'team' | 'seat',
	quantity = 1,
) {
	if (variant === 'team')
		return `Manage your ${quantity} ${details.title} seats`
	if (variant === 'seat') return `You've claimed your seat for ${details.title}`
	return `Welcome to ${details.title}`
}
