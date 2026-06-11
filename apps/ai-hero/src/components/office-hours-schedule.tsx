'use client'

import * as React from 'react'
import {
	buildOfficeHoursGoogleCalendarUrl,
	formatOfficeHoursUtcDate,
	formatOfficeHoursUtcTimeRange,
	groupOfficeHoursSessionsByUtcDate,
	isOfficeHoursSessionLive,
	isOfficeHoursSessionPast,
	sortOfficeHoursSessions,
	type CohortOfficeHoursSession,
} from '@/lib/cohort-office-hours'
import { ArrowUpRight } from 'lucide-react'

import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

type OfficeHoursScheduleProps = {
	sessions?: CohortOfficeHoursSession[]
	cohortId?: string
	variant?: 'lesson' | 'cohort'
	showActions?: boolean | 'false' | 'true'
	timeZone?: string
	timeZoneLabel?: string
	className?: string
}

type CohortOfficeHoursResource = {
	fields?: {
		officeHoursSessions?: CohortOfficeHoursSession[]
	}
}

function formatLocalDate(date: string, timeZone: string | null) {
	if (!timeZone) {
		return formatOfficeHoursUtcDate(date)
	}

	return new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		timeZone,
	}).format(new Date(date))
}

function formatLocalTimeRange(
	startAt: string,
	endsAt: string,
	timeZone: string | null,
	timeZoneLabel?: string,
) {
	if (!timeZone) {
		return formatOfficeHoursUtcTimeRange(startAt, endsAt)
	}

	const formatter = new Intl.DateTimeFormat('en-US', {
		hour: 'numeric',
		minute: '2-digit',
		timeZone,
	})
	const start = formatter.format(new Date(startAt))
	const end = formatter.format(new Date(endsAt))

	return `${start} to ${end}${timeZoneLabel ? ` ${timeZoneLabel}` : ''}`
}

function formatIcsDate(date: string) {
	return new Date(date)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '')
}

function escapeIcsText(value: string) {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r?\n/g, '\\n')
}

function buildOfficeHoursIcs(sessions: CohortOfficeHoursSession[]) {
	const dtstamp = formatIcsDate(new Date().toISOString())
	const events = sortOfficeHoursSessions(sessions).map((session) => {
		const uid = `cohort-office-hours-${session.youtubeBroadcastId}@aihero.dev`
		const description = [
			'Join live on YouTube to ask questions, get unstuck, and see the material in action.',
			'If you miss it, the replay and transcript will be available afterwards.',
			'',
			`Watch live: ${session.youtubeWatchUrl}`,
		].join('\n')

		return [
			'BEGIN:VEVENT',
			`UID:${uid}`,
			`DTSTAMP:${dtstamp}`,
			`DTSTART:${formatIcsDate(session.startsAt)}`,
			`DTEND:${formatIcsDate(session.endsAt)}`,
			`SUMMARY:${escapeIcsText(session.title)}`,
			`DESCRIPTION:${escapeIcsText(description)}`,
			'LOCATION:Online (YouTube Live)',
			`URL:${session.youtubeWatchUrl}`,
			'END:VEVENT',
		].join('\r\n')
	})

	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//AI Hero//Cohort Office Hours//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		...events,
		'END:VCALENDAR',
	].join('\r\n')
}

function downloadOfficeHoursIcs(sessions: CohortOfficeHoursSession[]) {
	const blob = new Blob([buildOfficeHoursIcs(sessions)], {
		type: 'text/calendar;charset=utf-8',
	})
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = 'ai-hero-office-hours.ics'
	document.body.appendChild(link)
	link.click()
	link.remove()
	URL.revokeObjectURL(url)
}

function useOfficeHoursSessions(props: OfficeHoursScheduleProps): {
	sessions: CohortOfficeHoursSession[]
	isLoading: boolean
} {
	const [fetchedSessions, setFetchedSessions] = React.useState<
		CohortOfficeHoursSession[]
	>(props.sessions || [])
	const [isLoading, setIsLoading] = React.useState(
		!props.sessions && Boolean(props.cohortId),
	)

	React.useEffect(() => {
		if (props.sessions) {
			setFetchedSessions(props.sessions)
			setIsLoading(false)
		}
	}, [props.sessions])

	React.useEffect(() => {
		if (props.sessions || !props.cohortId) return

		const cohortId = props.cohortId
		let isCancelled = false

		const loadSessions = async () => {
			setIsLoading(true)

			try {
				const response = await fetch(
					`/api/resources?slugOrId=${encodeURIComponent(cohortId)}&type=cohort`,
				)
				if (!response.ok) {
					throw new Error(
						`Failed to load cohort office hours: ${response.status}`,
					)
				}

				const resource = (await response.json()) as CohortOfficeHoursResource
				if (!isCancelled) {
					setFetchedSessions(resource.fields?.officeHoursSessions || [])
				}
			} catch (error) {
				if (!isCancelled) {
					console.error(error)
					setFetchedSessions([])
				}
			} finally {
				if (!isCancelled) {
					setIsLoading(false)
				}
			}
		}

		void loadSessions()

		return () => {
			isCancelled = true
		}
	}, [props.cohortId, props.sessions])

	return {
		sessions: fetchedSessions,
		isLoading,
	}
}

export function OfficeHoursSchedule({
	sessions: initialSessions,
	cohortId,
	variant = 'lesson',
	showActions = true,
	timeZone: configuredTimeZone,
	timeZoneLabel,
	className,
}: OfficeHoursScheduleProps) {
	const { sessions, isLoading } = useOfficeHoursSessions({
		sessions: initialSessions,
		cohortId,
		variant,
		showActions,
		timeZone: configuredTimeZone,
		timeZoneLabel,
		className,
	})
	const [detectedTimeZone, setDetectedTimeZone] = React.useState<string | null>(
		configuredTimeZone || null,
	)

	const [now, setNow] = React.useState(() => new Date())

	React.useEffect(() => {
		if (configuredTimeZone) return

		setDetectedTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
	}, [configuredTimeZone])

	React.useEffect(() => {
		const interval = window.setInterval(() => {
			setNow(new Date())
		}, 60_000)

		return () => window.clearInterval(interval)
	}, [])

	const groupedSessions = React.useMemo(
		() => groupOfficeHoursSessionsByUtcDate(sessions),
		[sessions],
	)
	const shouldShowActions = showActions !== false && showActions !== 'false'
	const displayTimeZone = configuredTimeZone || detectedTimeZone
	const displayTimeZoneLabel =
		timeZoneLabel ||
		(configuredTimeZone ? configuredTimeZone : 'your local time')
	const timeRangeLabel = timeZoneLabel || undefined
	const isDetectingTimeZone = !configuredTimeZone && !detectedTimeZone

	if (isLoading || isDetectingTimeZone) {
		return (
			<div
				className={cn(
					'text-muted-foreground -mx-5 border-y px-5 py-3 font-mono text-[10px] font-medium uppercase tracking-wider sm:-mx-8 sm:px-8 lg:-mx-10 lg:px-10',
					className,
				)}
			>
				{isLoading
					? 'Loading office hours schedule…'
					: 'Detecting your timezone…'}
			</div>
		)
	}

	if (groupedSessions.length === 0) {
		return null
	}

	const scheduleList = (
		<div
			className={cn(
				'divide-border -mx-5 flex flex-col divide-y border-y sm:-mx-8 lg:-mx-10',
				className,
			)}
		>
			{groupedSessions.map((group) => (
				<div key={group.dateKey}>
					<div className="bg-muted/40 flex flex-col gap-1 border-b px-5 py-3 sm:px-8 lg:px-10">
						<span className="text-muted-foreground/80 font-mono text-[10px] font-medium uppercase tracking-wider">
							{group.label}
						</span>
						<span className="text-[14px] font-semibold leading-tight tracking-[-0.005em]">
							{formatLocalDate(group.sessions[0]!.startsAt, displayTimeZone)}
						</span>
					</div>
					<div className="divide-border flex flex-col divide-y">
						{group.sessions.map((session) => {
							const isPast = isOfficeHoursSessionPast(session, now)
							const isLive = isOfficeHoursSessionLive(session, now)

							return (
								<div
									key={session.youtubeBroadcastId}
									className={cn(
										'hover:bg-card flex flex-col gap-3 px-5 py-3 transition-colors duration-150 ease-out sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10',
										isPast && 'opacity-70 hover:opacity-100',
									)}
								>
									<div className="flex min-w-0 flex-col gap-0.5">
										<div className="flex flex-wrap items-center gap-2">
											<span className="text-[14px] font-medium leading-tight tracking-[-0.005em]">
												{formatLocalTimeRange(
													session.startsAt,
													session.endsAt,
													displayTimeZone,
													timeRangeLabel,
												)}
											</span>
											{isLive && (
												<span className="bg-primary text-primary-foreground rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider">
													Live now
												</span>
											)}
											{isPast && (
												<span className="text-muted-foreground rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider">
													Past session
												</span>
											)}
										</div>
										<span className="text-muted-foreground/70 font-mono text-[10px] font-medium uppercase tracking-wider">
											{displayTimeZoneLabel}
										</span>
									</div>
									{shouldShowActions && (
										<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
											<Button
												asChild
												variant="outline"
												size="sm"
												className="h-8 w-full rounded-none text-[12px] font-medium tracking-[-0.005em] sm:w-auto"
											>
												<a
													href={session.youtubeWatchUrl}
													target="_blank"
													rel="noreferrer"
												>
													{isPast ? 'Watch Replay' : 'Watch on YouTube'}
													<ArrowUpRight
														className="ml-1 size-3"
														aria-hidden="true"
													/>
												</a>
											</Button>
											{isPast ? (
												<span className="text-muted-foreground/60 text-[12px] font-medium tracking-[-0.005em]">
													Calendar closed
												</span>
											) : (
												<a
													href={buildOfficeHoursGoogleCalendarUrl(session)}
													target="_blank"
													rel="noreferrer"
													className="text-muted-foreground hover:text-foreground text-[12px] font-medium tracking-[-0.005em] underline-offset-4 transition-colors hover:underline"
												>
													Add to Calendar
												</a>
											)}
										</div>
									)}
								</div>
							)
						})}
					</div>
				</div>
			))}
		</div>
	)

	const timezoneNote = (
		<p className="text-muted-foreground/70 font-mono text-[10px] font-medium uppercase tracking-wider">
			Times shown in {displayTimeZoneLabel}.
		</p>
	)
	const calendarDownload = shouldShowActions ? (
		<button
			type="button"
			onClick={() => downloadOfficeHoursIcs(sessions)}
			className="text-muted-foreground hover:text-foreground self-start font-mono text-[10px] font-medium uppercase tracking-wider underline-offset-4 transition-colors hover:underline"
		>
			Download calendar file
		</button>
	) : null

	if (variant === 'lesson') {
		return (
			<div className="not-prose flex flex-col gap-3">
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
					{timezoneNote}
					{calendarDownload}
				</div>
				{scheduleList}
			</div>
		)
	}

	return (
		<section className="not-prose -mx-5 border-y sm:-mx-8 lg:-mx-10">
			<div className="flex flex-col gap-6 px-5 py-10 sm:px-8 lg:px-10">
				<div className="flex flex-col gap-3">
					<h2 className="text-2xl font-semibold tracking-tight">
						Office hours on YouTube
					</h2>
					<p className="text-muted-foreground max-w-3xl text-base leading-7">
						Live on YouTube. Replays and transcripts are included.
					</p>
				</div>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
						{timezoneNote}
						{calendarDownload}
					</div>
					{scheduleList}
				</div>
			</div>
		</section>
	)
}
