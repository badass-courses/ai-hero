import * as React from 'react'
import Link from 'next/link'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { TYPE } from '@/components/landing/type'
import type { Cohort } from '@/lib/cohort'
import { differenceInCalendarDays } from 'date-fns'
import { formatInTimeZone } from 'date-fns-tz'

import { cn } from '@coursebuilder/utils/cn'

/**
 * How much time the cohort asks for. Not a per-cohort field: it is the
 * canonical support answer ("plan on 5 to 8 hours a week"), so it lives here
 * as editable copy rather than being derived from anything.
 */
const EFFORT = '5–8 hrs / week'

/**
 * Track counts are enumerated because Tailwind only sees class strings it can
 * read literally — a template-built `repeat(${n},…)` compiles to nothing.
 */
const COLUMNS: Record<number, string> = {
	1: 'sm:grid-cols-[repeat(1,minmax(0,1fr))]',
	2: 'sm:grid-cols-[repeat(2,minmax(0,1fr))]',
	3: 'sm:grid-cols-[repeat(3,minmax(0,1fr))]',
	4: 'sm:grid-cols-[repeat(4,minmax(0,1fr))]',
}

export type Fact = {
	label: React.ReactNode
	value: React.ReactNode
	/** Counts and numerals are mono; prose values are not. */
	mono?: boolean
	/** A cell that leads somewhere is the whole cell, not a link inside it. */
	href?: string
	external?: boolean
	/** Asks the viewer to do something, so the value reads as the action. */
	action?: boolean
}

/**
 * Derives "2-week cohort" from the cohort's own dates. Rounds to whole weeks
 * because that is how the cohort is sold; a cohort without both dates has no
 * honest answer here, so it gets no cell.
 *
 * Calendar days are counted in the cohort's own timezone, matching the "Starts"
 * fact beside it. Counting them in the runtime's zone instead (UTC in
 * production) shifts a late-evening PT boundary onto the next day, which is
 * enough to move a cohort across the 10-day "days vs weeks" threshold or the
 * week rounding — the strip would then disagree with the date printed next to
 * it.
 */
function formatDuration(
	startsAt: string | undefined,
	endsAt: string | undefined,
	timeZone: string,
): string | null {
	if (!startsAt || !endsAt) return null
	// `yyyy-MM-dd` in the cohort's zone, parsed back as a plain local date, so
	// the difference is a pure calendar-day count with no zone left in it.
	const days =
		differenceInCalendarDays(
			new Date(formatInTimeZone(endsAt, timeZone, 'yyyy-MM-dd')),
			new Date(formatInTimeZone(startsAt, timeZone, 'yyyy-MM-dd')),
		) + 1
	if (days < 1) return null
	if (days <= 10) return `${days}-day cohort`
	return `${Math.round(days / 7)}-week cohort`
}

/**
 * The four labelled facts under the author: format, start date, effort, and
 * how many engineers have been through a cohort. Every value is real — a fact
 * we cannot answer is dropped rather than filled in, so the strip renders with
 * however many cells it has (and not at all if it has none).
 *
 * Below `sm` it is a list of rows, label on the left and value on the right.
 * Two cells across left about 110px for a value on a phone, which is less
 * than "November 9, 2026" needs, so one cell wrapped and its row grew taller
 * than its neighbour. A row has the whole width and never wraps.
 *
 * @param alumniLabel - Pre-formatted alumni count, or null when there are too
 *   few to quote. Resolved by the page so this stays a pure renderer.
 */
export const CohortFactStrip: React.FC<{
	cohort: Cohort
	alumniLabel: string | null
	className?: string
}> = ({ cohort, alumniLabel, className }) => {
	const { startsAt, endsAt, timezone } = cohort.fields
	const tz = timezone || 'America/Los_Angeles'
	const duration = formatDuration(startsAt, endsAt, tz)

	const candidates: (Fact | null)[] = [
		duration ? { label: 'Format', value: duration } : null,
		startsAt
			? {
					label: 'Starts',
					value: formatInTimeZone(startsAt, tz, 'MMMM d, yyyy'),
				}
			: null,
		{ label: 'Effort', value: EFFORT },
		alumniLabel
			? { label: 'Trained', value: alumniLabel, mono: true }
			: null,
	]
	const facts = candidates.filter((fact): fact is Fact => fact !== null)

	return <FactGrid facts={facts} className={className} />
}

/** The strip's grid. Shared by the sales facts and the buyer's own. */
export function FactGrid({
	facts,
	className,
}: {
	facts: Fact[]
	className?: string
}) {
	if (facts.length === 0) return null

	return (
		<dl
			className={cn(
				'border-border bg-border grid w-full grid-cols-1 gap-px overflow-hidden rounded-lg border',
				COLUMNS[facts.length],
				className,
			)}
		>
			{facts.map((fact, index) => {
				// From `sm`, `flex-col-reverse`: a `<dl>` wants `<dt>` before `<dd>`
				// in the DOM, and `TYPE.statLabel` is a caption that sits BELOW the
				// value it names. Reversing the visual order satisfies both. The
				// phone's row reads in DOM order, so it needs no reversal.
				const cell =
					'bg-background flex min-w-0 items-baseline justify-between gap-4 px-4 py-3 text-left sm:flex-col-reverse sm:items-stretch sm:justify-end sm:gap-0 sm:py-3.5'
				const body = (
					<>
						<dt className={cn(TYPE.statLabel, 'mt-0 truncate sm:mt-1.5')}>
							{fact.label}
						</dt>
						<dd
							className={cn(
								TYPE.bodyTight,
								'flex min-w-0 items-center justify-end gap-1.5 sm:justify-start',
								fact.mono && 'font-mono tabular-nums',
								fact.action && 'text-primary',
							)}
						>
							<span className="truncate">{fact.value}</span>
							{fact.href ? (
								// A linked cell says so: the arrow is the affordance, and it
								// nudges toward where the cell goes.
								fact.external ? (
									<ArrowUpRight
										aria-hidden="true"
										className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
									/>
								) : (
									<ArrowRight
										aria-hidden="true"
										className={cn(
											'size-4 shrink-0 transition-transform group-hover:translate-x-0.5',
											fact.action ? 'text-primary' : 'text-muted-foreground',
										)}
									/>
								)
							) : null}
						</dd>
					</>
				)
				// A `<dl>` may only hold `<div>`s around its pairs, so a linked cell
				// keeps its `<div>` and lays the link over it.
				return (
					<div
						key={index}
						className={cn(
							cell,
							fact.href && 'hover:bg-card group relative cursor-pointer transition-colors',
						)}
					>
						{body}
						{fact.href ? (
							fact.external ? (
								<a
									href={fact.href}
									target="_blank"
									rel="noreferrer"
									className="absolute inset-0"
								>
									<span className="sr-only">{fact.label}</span>
								</a>
							) : (
								<Link href={fact.href} className="absolute inset-0">
									<span className="sr-only">{fact.label}</span>
								</Link>
							)
						) : null}
					</div>
				)
			})}
		</dl>
	)
}
