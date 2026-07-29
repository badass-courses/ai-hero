import * as React from 'react'
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

type Fact = {
	label: string
	value: string
	/** Counts and numerals are mono; prose values are not. */
	mono?: boolean
}

/**
 * Derives "2-week cohort" from the cohort's own dates. Rounds to whole weeks
 * because that is how the cohort is sold; a cohort without both dates has no
 * honest answer here, so it gets no cell.
 */
function formatDuration(startsAt?: string, endsAt?: string): string | null {
	if (!startsAt || !endsAt) return null
	const days = differenceInCalendarDays(new Date(endsAt), new Date(startsAt)) + 1
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
	const duration = formatDuration(startsAt, endsAt)

	const facts: Fact[] = [
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
	].filter((fact): fact is Fact => fact !== null)

	if (facts.length === 0) return null

	return (
		<dl
			className={cn(
				'border-border bg-border grid w-full grid-cols-[repeat(2,minmax(0,1fr))] gap-px overflow-hidden rounded-lg border',
				COLUMNS[facts.length],
				className,
			)}
		>
			{facts.map((fact) => (
				<div
					key={fact.label}
					className="bg-background flex flex-col gap-1.5 px-4 py-3.5 text-left"
				>
					<dt
						className={cn(
							TYPE.micro,
							'text-[color:var(--ah-fg-label)]',
						)}
					>
						{fact.label}
					</dt>
					<dd
						className={cn(
							TYPE.bodyTight,
							fact.mono && 'font-mono tabular-nums',
						)}
					>
						{fact.value}
					</dd>
				</div>
			))}
			{/* Odd counts leave a hole in the 2-up mobile grid; the filler keeps the
			    trailing hairline unbroken. */}
			{facts.length % 2 === 1 && (
				<div aria-hidden className="bg-background sm:hidden" />
			)}
		</dl>
	)
}
