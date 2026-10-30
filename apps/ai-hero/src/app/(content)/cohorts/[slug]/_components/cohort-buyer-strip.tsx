import * as React from 'react'
import { BADGE_SOLID, TYPE } from '@/components/landing/type'
import type { Cohort } from '@/lib/cohort'
import { isWorkshopAvailable } from '@/lib/cohort-navigation'
import {
	isOfficeHoursSessionLive,
	isOfficeHoursSessionPast,
	sortOfficeHoursSessions,
} from '@/lib/cohort-office-hours'
import type { Workshop } from '@/lib/workshops'
import { differenceInCalendarDays } from 'date-fns'
import { formatInTimeZone } from 'date-fns-tz'

import type { ModuleProgress } from '@coursebuilder/core/schemas'
import { cn } from '@coursebuilder/utils/cn'

import { FactGrid, type Fact } from './cohort-fact-strip'
import { LocalTime } from './local-time'

/** Where the cohort is for this viewer today, in the cohort's own calendar. */
export type CohortMoment =
	| { phase: 'before'; days: number }
	| { phase: 'during'; week: number; weeks: number }
	| { phase: 'after' }

export function cohortMoment(
	startsAt: string,
	endsAt: string | undefined,
	timeZone: string,
	now: Date,
): CohortMoment {
	const day = (date: string | Date) =>
		new Date(formatInTimeZone(date, timeZone, 'yyyy-MM-dd'))
	if (now < new Date(startsAt)) {
		return { phase: 'before', days: differenceInCalendarDays(day(startsAt), day(now)) }
	}
	if (endsAt && now > new Date(endsAt)) return { phase: 'after' }
	const sinceStart = differenceInCalendarDays(day(now), day(startsAt))
	// Rounded like the sales strip's "2-week cohort", so the two agree.
	const weeks = endsAt
		? Math.max(1, Math.round((differenceInCalendarDays(day(endsAt), day(startsAt)) + 1) / 7))
		: Math.floor(sinceStart / 7) + 1
	return { phase: 'during', week: Math.min(weeks, Math.floor(sinceStart / 7) + 1), weeks }
}

type Node = { id?: string; fields?: Record<string, unknown> | null; resources?: { resource?: Node }[] | null }

/**
 * The next lesson's fields. Progress may carry only its id, so the title and
 * slug come from the workshop's own tree, where lessons can sit in sections.
 */
function findLesson(workshop: Workshop, next: Node | null | undefined) {
	if (!next?.id) return next?.fields ?? null
	const search = (nodes: Node['resources']): Node['fields'] | null => {
		for (const { resource } of nodes ?? []) {
			if (resource && resource.id === next.id) return resource.fields ?? null
			const found = search(resource?.resources)
			if (found) return found
		}
		return null
	}
	return search((workshop as Node).resources) ?? next.fields ?? null
}

/**
 * The first open workshop, in authored order, with lessons left to do, and the
 * lesson to pick up there. Null when every open workshop is done.
 */
export function upNext(
	workshops: Workshop[],
	progress: (ModuleProgress | null)[],
	now: Date,
) {
	for (const [index, workshop] of workshops.entries()) {
		if (
			!isWorkshopAvailable(
				{ state: workshop.fields.state, startsAt: workshop.fields.startsAt ?? null },
				now,
			)
		) {
			continue
		}
		const done = progress[index]?.completedLessonsCount ?? 0
		const total = progress[index]?.totalLessonsCount ?? 0
		if (total > 0 && done >= total) continue
		const lesson = findLesson(workshop, progress[index]?.nextResource)
		return {
			workshop: workshop.fields.title,
			lesson: typeof lesson?.title === 'string' ? lesson.title : null,
			done,
			total,
			href: `/workshops/${workshop.fields.slug}${typeof lesson?.slug === 'string' ? `/${lesson.slug}` : ''}`,
		}
	}
	return null
}

/**
 * The fact strip for someone already in the cohort: what to do next, where the
 * cohort is, the next office hours and Discord. Each cell leads to its thing.
 * A cell with nothing true to say is dropped, as on the sales strip.
 */
export async function CohortBuyerStrip({
	cohort,
	workshops,
	workshopProgressMap,
	isDiscordConnected,
	className,
	now = new Date(),
}: {
	cohort: Cohort
	workshops: Workshop[]
	workshopProgressMap: Map<string, Promise<ModuleProgress | null>>
	isDiscordConnected: Promise<boolean>
	className?: string
	now?: Date
}) {
	const { startsAt, endsAt, timezone, officeHoursSessions } = cohort.fields
	const tz = timezone || 'America/Los_Angeles'
	const [progress, discord] = await Promise.all([
		Promise.all(
			workshops.map(
				(workshop) =>
					workshopProgressMap.get(workshop.fields.slug) ?? Promise.resolve(null),
			),
		).catch(() => workshops.map(() => null)),
		isDiscordConnected.catch(() => false),
	])

	const next = upNext(workshops, progress, now)
	const moment = startsAt ? cohortMoment(startsAt, endsAt, tz, now) : null
	const session = sortOfficeHoursSessions(officeHoursSessions ?? []).find(
		(candidate) => !isOfficeHoursSessionPast(candidate, now),
	)

	const facts: (Fact | null)[] = [
		next
			? {
					label: next.total ? `Up next · ${next.done}/${next.total}` : 'Up next',
					value: next.lesson ?? next.workshop,
					href: next.href,
					action: true,
				}
			: moment?.phase !== 'before'
				? { label: 'Up next', value: 'All caught up' }
				: null,
		moment?.phase === 'before' && startsAt
			? {
					label: (
						<>
							Starts{' '}
							<LocalTime
								iso={startsAt}
								fallbackTimeZone={tz}
								options={{ weekday: 'short', month: 'short', day: 'numeric' }}
							/>
						</>
					),
					value:
						moment.days <= 0 ? 'Today' : moment.days === 1 ? 'Tomorrow' : `In ${moment.days} days`,
				}
			: moment?.phase === 'during'
				? { label: 'In session', value: `Week ${moment.week} of ${moment.weeks}` }
				: moment?.phase === 'after'
					? { label: 'Cohort', value: 'Wrapped up' }
					: null,
		session
			? {
					label: 'Office hours',
					value: isOfficeHoursSessionLive(session, now) ? (
						<span className={cn(TYPE.badge, BADGE_SOLID)}>Live now</span>
					) : (
						<LocalTime
							iso={session.startsAt}
							fallbackTimeZone={tz}
							options={{ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }}
						/>
					),
					href: session.youtubeWatchUrl,
					external: true,
				}
			: null,
		discord
			? { label: 'Discord', value: 'Connected', href: '/discord' }
			: { label: 'Discord', value: 'Connect account', href: '/discord/roles', action: true },
	]

	return (
		<FactGrid
			facts={facts.filter((fact): fact is Fact => fact !== null)}
			className={className}
		/>
	)
}
