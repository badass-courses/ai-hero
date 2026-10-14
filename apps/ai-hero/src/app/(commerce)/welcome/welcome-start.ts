import { formatInTimeZone } from 'date-fns-tz'
import pluralize from 'pluralize'

type StartProduct = {
	type?: string | null
	resources?: Array<{
		resource?: { fields?: Record<string, unknown> | null } | null
	} | null> | null
} | null

type StartResource = {
	type: string
	fields?: { slug?: string | null } | null
}

export type WelcomeStart = {
	href: string
	label: string
	/**
	 * When the cohort begins and that we will write when it does, for a cohort
	 * that has not started yet. The email is the workshop access email the daily
	 * job sends as each workshop opens; the wording follows the welcome email.
	 */
	startsLabel: string | null
}

const PACIFIC = 'America/Los_Angeles'

/**
 * Where the welcome page sends a buyer who owns a seat: the course's first
 * resource, or the cohort's page. Nothing for a buyer who only bought seats
 * for others, and nothing for a live ticket. The rules are the shared welcome
 * page's; the cohort date now reads in the cohort's own time zone.
 */
export function welcomeStart({
	product,
	productResources,
	ownsASeat,
	now = new Date(),
}: {
	product: StartProduct
	productResources?: StartResource[] | null
	ownsASeat: boolean
	now?: Date
}): WelcomeStart | null {
	if (!ownsASeat) return null
	const first = productResources?.[0]
	const slug = first?.fields?.slug
	if (!first || !slug) return null

	if (product?.type === 'self-paced') {
		return {
			href: `/${pluralize(first.type)}/${slug}`,
			label: 'Start learning',
			startsLabel: null,
		}
	}

	if (product?.type === 'cohort') {
		const fields = product.resources?.[0]?.resource?.fields
		const startsAt =
			typeof fields?.startsAt === 'string' ? new Date(fields.startsAt) : null
		const upcoming =
			startsAt && !Number.isNaN(startsAt.getTime()) && startsAt > now
		const timezone =
			typeof fields?.timezone === 'string' && fields.timezone
				? fields.timezone
				: PACIFIC
		return {
			href: `/${pluralize(product.type)}/${slug}`,
			label: upcoming ? 'Go to your cohort' : 'Start learning',
			startsLabel: upcoming
				? `Class starts ${formatInTimeZone(startsAt, timezone, "MMM d 'at' h:mm a zzz")}. We'll email you when the first workshops unlock.`
				: null,
		}
	}

	return null
}
