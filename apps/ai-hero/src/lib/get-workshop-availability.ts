import { formatInTimeZone } from 'date-fns-tz'

export interface WorkshopSummary {
	title: string
	slug: string
}

export interface UpcomingGroup {
	date: string
	workshops: WorkshopSummary[]
}

export interface WorkshopAvailability {
	availableNow: WorkshopSummary[]
	upcoming: UpcomingGroup[]
}

/**
 * Splits a cohort's workshops into "available now" and "upcoming" groups.
 *
 * - Workshops with no startsAt or startsAt <= now go into availableNow
 * - Workshops with startsAt > now are grouped by date into upcoming
 * - Both lists preserve position ordering
 *
 * @param workshopResources - Array of { resource, position } from cohort.resources
 * @param now - Current time (injectable for testing)
 */
export function getWorkshopAvailability(
	workshopResources: Array<{
		resource: {
			fields?: { title?: string; slug?: string; startsAt?: string | null }
		}
		position: number
	}>,
	now: Date = new Date(),
): WorkshopAvailability {
	const sorted = [...workshopResources].sort((a, b) => a.position - b.position)

	const availableNow: WorkshopSummary[] = []
	const upcomingMap = new Map<string, WorkshopSummary[]>()

	for (const item of sorted) {
		if (!item.resource) continue
		const fields = item.resource.fields
		if (!fields?.title || !fields?.slug) continue

		const summary: WorkshopSummary = {
			title: fields.title,
			slug: fields.slug,
		}

		const startsAt = fields.startsAt
		if (!startsAt || new Date(startsAt) <= now) {
			availableNow.push(summary)
		} else {
			const dateKey = formatInTimeZone(
				new Date(startsAt),
				'America/Los_Angeles',
				'MMMM do, yyyy',
			)
			const group = upcomingMap.get(dateKey) || []
			group.push(summary)
			upcomingMap.set(dateKey, group)
		}
	}

	const upcoming: UpcomingGroup[] = Array.from(upcomingMap.entries()).map(
		([date, workshops]) => ({ date, workshops }),
	)

	return { availableNow, upcoming }
}
