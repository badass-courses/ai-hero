'use client'

import * as React from 'react'
import {
	buildOfficeHoursGoogleCalendarUrl,
	formatOfficeHoursUtcDate,
	formatOfficeHoursUtcTimeRange,
	groupOfficeHoursSessionsByDate,
	isOfficeHoursSessionLive,
	isOfficeHoursSessionPast,
	sortOfficeHoursSessions,
	type CohortOfficeHoursSession,
} from '@/lib/cohort-office-hours'
import { ArrowUpRight } from 'lucide-react'
import { BADGE_OUTLINE, BADGE_SOLID, TYPE } from '@/components/landing/type'

import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

type OfficeHoursScheduleProps = {
	sessions?: CohortOfficeHoursSession[]
	variant?: 'lesson' | 'cohort'
	showActions?: boolean | 'false' | 'true'
	timeZone?: string
	timeZoneLabel?: string
	className?: string
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
) {
	if (!timeZone) {
		return formatOfficeHoursUtcTimeRange(startAt, endsAt)
	}

	return new Intl.DateTimeFormat('en-US', {
		hour: 'numeric',
		minute: '2-digit',
		timeZone,
	}).formatRange(new Date(startAt), new Date(endsAt))
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

export function OfficeHoursSchedule({
	sessions = [],
	variant = 'lesson',
	showActions = true,
	timeZone: configuredTimeZone,
	timeZoneLabel,
	className,
}: OfficeHoursScheduleProps) {
	// Without a configured zone, times follow the viewer's own clock. The
	// server can't know it, so the first render waits for the browser.
	const [detectedTimeZone, setDetectedTimeZone] = React.useState<string | null>(
		configuredTimeZone || null,
	)
	const [now, setNow] = React.useState(() => new Date())

	React.useEffect(() => {
		if (configuredTimeZone) return
		setDetectedTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
	}, [configuredTimeZone])

	React.useEffect(() => {
		const interval = window.setInterval(() => setNow(new Date()), 60_000)
		return () => window.clearInterval(interval)
	}, [])

	const displayTimeZone = configuredTimeZone || detectedTimeZone
	const groupedSessions = React.useMemo(
		() => groupOfficeHoursSessionsByDate(sessions, displayTimeZone ?? 'UTC'),
		[sessions, displayTimeZone],
	)
	if (groupedSessions.length === 0) return null

	const shouldShowActions = showActions !== false && showActions !== 'false'
	const zoneName = timeZoneLabel || displayTimeZone?.replace(/_/g, ' ')
	const zoneNote = configuredTimeZone
		? `Times in ${zoneName}`
		: `Times in your time zone${zoneName ? ` · ${zoneName}` : ''}`

	const schedule = (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<p className={TYPE.groupLabel}>{zoneNote}</p>
				{shouldShowActions ? (
					<button
						type="button"
						onClick={() => downloadOfficeHoursIcs(sessions)}
						className={cn(
							TYPE.groupLabel,
							'hover:text-foreground underline-offset-4 transition-colors hover:underline',
						)}
					>
						Download all (.ics)
					</button>
				) : null}
			</div>
			<div className="bg-border border-border grid gap-px overflow-hidden rounded-[9px] border">
				{groupedSessions.map((group) => (
					<div
						key={group.dateKey}
						className="bg-background grid gap-px sm:grid-cols-[11rem_1fr]"
					>
						<div className="bg-card flex flex-col gap-1 px-4 py-3">
							<span className={cn(TYPE.metaMark)}>{group.label}</span>
							<span className={TYPE.cardTitle}>
								{displayTimeZone
									? formatLocalDate(group.sessions[0]!.startsAt, displayTimeZone)
									: '\u00a0'}
							</span>
						</div>
						<div className="bg-border grid gap-px">
							{group.sessions.map((session) => {
								const isPast = isOfficeHoursSessionPast(session, now)
								const isLive = isOfficeHoursSessionLive(session, now)

								return (
									<div
										key={session.youtubeBroadcastId}
										className={cn(
											'bg-background flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3',
											isPast && 'text-muted-foreground',
										)}
									>
										<div className="flex items-center gap-2">
											<span className={cn(TYPE.meta, 'tabular-nums')}>
												{displayTimeZone
													? formatLocalTimeRange(
															session.startsAt,
															session.endsAt,
															displayTimeZone,
														)
													: '\u00a0'}
											</span>
											{isLive ? (
												<span className={cn(TYPE.badge, BADGE_SOLID)}>Live now</span>
											) : isPast ? (
												<span className={cn(TYPE.badge, BADGE_OUTLINE)}>Past</span>
											) : null}
										</div>
										{shouldShowActions ? (
											<div className="flex items-center gap-4">
												{isPast ? null : (
													<a
														href={buildOfficeHoursGoogleCalendarUrl(session)}
														target="_blank"
														rel="noreferrer"
														className={cn(
															TYPE.metaSm,
															'text-muted-foreground hover:text-foreground underline-offset-4 transition-colors hover:underline',
														)}
													>
														Add to calendar
													</a>
												)}
												<Button
													asChild
													variant={isLive ? 'default' : 'outline'}
													size="sm"
													className="h-8 rounded-[6px]"
												>
													<a
														href={session.youtubeWatchUrl}
														target="_blank"
														rel="noreferrer"
													>
														{isPast ? 'Watch replay' : 'YouTube'}
														<ArrowUpRight className="ml-1 size-3" aria-hidden="true" />
													</a>
												</Button>
											</div>
										) : null}
									</div>
								)
							})}
						</div>
					</div>
				))}
			</div>
		</div>
	)

	if (variant === 'lesson') {
		return <div className={cn('not-prose my-8', className)}>{schedule}</div>
	}

	return (
		<section className={cn('not-prose my-10 flex flex-col gap-5', className)}>
			<div className="flex flex-col gap-2">
				<h2 className={TYPE.subhead}>Office hours on YouTube</h2>
				<p className={cn(TYPE.metaProse, 'text-muted-foreground')}>
					Live on YouTube. Replays and transcripts are included.
				</p>
			</div>
			{schedule}
		</section>
	)
}
