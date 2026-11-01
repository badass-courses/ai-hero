'use client'

import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { BADGE_OUTLINE, TYPE } from '@/components/landing/type'
import {
	DROVR_SIGNUPS_FROM,
	mergeSignupReads,
	type NewsletterSignups,
	type SignupRange,
	type SignupTotal,
} from '@/lib/analytics/newsletter-signups-series'

const number = new Intl.NumberFormat('en-US')
const UNAVAILABLE = 'unavailable'

// unknown and unattributed are drovr's reserved keys and show as they are.
const SOURCE_LABELS: Record<string, string> = {
	'kit-frozen': 'Kit (frozen)',
	'ai-hero': 'Site signups',
	kit: 'Kit-only arrivals',
	'list-import': 'Imported lists',
}

export function signupSourceLabel(source: string) {
	return SOURCE_LABELS[source] ?? source
}

function dayLabel(day: string) {
	return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	})
}

function longDayLabel(day: string) {
	return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC',
	})
}

function monthLabel(month: string) {
	return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', {
		month: 'short',
		year: 'numeric',
		timeZone: 'UTC',
	})
}

/** The views on offer. 30 days also shows the last 7; the rest go by month. */
const VIEWS = [
	{ range: '30d', label: '30 days' },
	{ range: '90d', label: '90 days' },
	{ range: '365d', label: '12 months' },
	{ range: 'all', label: 'All' },
] as const satisfies ReadonlyArray<{ range: SignupRange; label: string }>
export type SignupView = (typeof VIEWS)[number]['range']
const viewLabel = (range: SignupRange) =>
	VIEWS.find((view) => view.range === range)?.label ?? '7 days'

/** Which days came from where, and how fresh each part is. */
export function provenanceLabel(data: NewsletterSignups) {
	const parts: string[] = []
	const { history } = data
	if (data.days.some((day) => day.source === 'kit-frozen'))
		parts.push(
			history.status === 'available'
				? `Through ${longDayLabel(history.to)}: Kit (frozen ${history.frozenOn}).`
				: `Through ${longDayLabel(history.to)}: Kit (frozen) history unavailable.`,
		)
	if (data.days.some((day) => day.source === 'drovr'))
		parts.push(
			data.asOf
				? `From ${longDayLabel(DROVR_SIGNUPS_FROM)}: drovr, as of ${new Date(
						data.asOf,
					).toLocaleString('en-US', {
						dateStyle: 'medium',
						timeStyle: 'short',
						timeZone: 'UTC',
					})} UTC.`
				: `From ${longDayLabel(DROVR_SIGNUPS_FROM)}: drovr unavailable.`,
		)
	return parts.join(' ')
}

/** What a total covers. Missing and partial days are named, never hidden. */
export function coverageLabel(total: SignupTotal) {
	if (total.complete) return `${total.days} full days`
	const parts = [`${total.reportedDays} of ${total.days} days reported`]
	if (total.partialDays > 0)
		parts.push(
			total.partialDays === 1
				? '1 day still counting'
				: `${total.partialDays} days still counting`,
		)
	return parts.join(' · ')
}

function sourceTotal(total: SignupTotal | 'loading' | null, source: string) {
	if (total === 'loading') return '…'
	return total && total.reportedDays > 0
		? number.format(total.subscribed.bySource[source] ?? 0)
		: UNAVAILABLE
}

function TotalTile({
	label,
	total,
}: {
	label: string
	/** null: the read failed. */
	total: SignupTotal | 'loading' | null
}) {
	const known = total !== 'loading' && total !== null && total.reportedDays > 0
	return (
		<div className="bg-card p-3">
			<div className={TYPE.statSm}>
				{total === 'loading'
					? 'Loading…'
					: known
						? number.format(total.subscribed.total)
						: UNAVAILABLE}
			</div>
			<div className={TYPE.statLabel}>{label}</div>
			{known && <p className={`${TYPE.metaMark} mt-1`}>{coverageLabel(total)}</p>}
			{known && (total.confirmed !== null || total.unsubscribed !== null) && (
				<p className={`${TYPE.metaMark} mt-1`}>
					{total.confirmed !== null &&
						`${number.format(total.confirmed)} confirmed`}
					{total.confirmed !== null && total.unsubscribed !== null && ' · '}
					{total.unsubscribed !== null &&
						`${number.format(total.unsubscribed)} unsubscribes (all contacts)`}
				</p>
			)}
		</div>
	)
}

function MonthlyTable({ data }: { data: NewsletterSignups }) {
	return (
		<div className="overflow-x-auto">
			<table className={`${TYPE.meta} w-full text-left tabular-nums`}>
				<thead className={TYPE.metaMark}>
					<tr>
						<th className="py-1 pr-3 font-normal">Month</th>
						<th className="py-1 pr-3 font-normal">New</th>
						{data.sources.map((source) => (
							<th key={source} className="py-1 pr-3 font-normal">
								{signupSourceLabel(source)}
							</th>
						))}
						<th className="py-1 pr-3 font-normal">Days</th>
					</tr>
				</thead>
				<tbody>
					{[...data.months].reverse().map(({ month, total }) => (
						<tr
							key={month}
							data-month={month}
							className="border-[color:var(--ah-line-soft)] border-t"
						>
							<td className="py-1 pr-3 whitespace-nowrap">
								{monthLabel(month)}
							</td>
							{total.reportedDays === 0 ? (
								<td
									colSpan={data.sources.length + 2}
									className="text-muted-foreground py-1 pr-3"
								>
									{UNAVAILABLE}
								</td>
							) : (
								<>
									<td className="py-1 pr-3">
										{number.format(total.subscribed.total)}
									</td>
									{data.sources.map((source) => (
										<td key={source} className="py-1 pr-3">
											{number.format(total.subscribed.bySource[source] ?? 0)}
										</td>
									))}
									<td className="py-1 pr-3">{coverageLabel(total)}</td>
								</>
							)}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

function DailyTable({ data }: { data: NewsletterSignups }) {
	const showConfirmed = data.days.some(
		(day) => day.status !== 'unavailable' && day.confirmed !== null,
	)
	const showUnsubscribed = data.days.some(
		(day) => day.status !== 'unavailable' && day.unsubscribed !== null,
	)
	const columns = 2 + data.sources.length + +showConfirmed + +showUnsubscribed
	const cell = (n: number | null) => (n === null ? '–' : number.format(n))
	return (
		<>
			{showUnsubscribed && (
				<p className={TYPE.metaMark}>
					Unsubscribes count every contact that moved to unsubscribed,
					including imported lists and older contacts, with no source split.
					They are not newsletter churn.
				</p>
			)}
			<div className="overflow-x-auto">
				<table className={`${TYPE.meta} w-full text-left tabular-nums`}>
					<thead className={TYPE.metaMark}>
						<tr>
							<th className="py-1 pr-3 font-normal">Day</th>
							<th className="py-1 pr-3 font-normal">New</th>
							{data.sources.map((source) => (
								<th key={source} className="py-1 pr-3 font-normal">
									{signupSourceLabel(source)}
								</th>
							))}
							{showConfirmed && (
								<th className="py-1 pr-3 font-normal">Confirmed</th>
							)}
							{showUnsubscribed && (
								<th className="py-1 pr-3 font-normal">
									Unsubscribes (all contacts)
								</th>
							)}
						</tr>
					</thead>
					<tbody>
						{[...data.days].reverse().map((day) => (
							<tr
								key={day.day}
								data-day={day.day}
								data-source={day.source}
								className="border-[color:var(--ah-line-soft)] border-t"
							>
								<td className="py-1 pr-3 whitespace-nowrap">
									{dayLabel(day.day)}
									{day.status === 'partial' && (
										<span className={`${TYPE.badge} ${BADGE_OUTLINE} ml-2`}>
											so far
										</span>
									)}
								</td>
								{day.status === 'unavailable' ? (
									<td
										colSpan={columns - 1}
										className="text-muted-foreground py-1 pr-3"
									>
										{day.source === 'kit-frozen'
											? `${UNAVAILABLE} (Kit frozen)`
											: UNAVAILABLE}
									</td>
								) : (
									<>
										<td className="py-1 pr-3">
											{number.format(day.subscribed.total)}
										</td>
										{data.sources.map((source) => (
											<td key={source} className="py-1 pr-3">
												{number.format(day.subscribed.bySource[source] ?? 0)}
											</td>
										))}
										{showConfirmed && (
											<td className="py-1 pr-3">{cell(day.confirmed)}</td>
										)}
										{showUnsubscribed && (
											<td className="py-1 pr-3">{cell(day.unsubscribed)}</td>
										)}
									</>
								)}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</>
	)
}

export function NewsletterSignupsView({
	data,
	last30,
}: {
	/** The read to draw: 30 days once loaded, else the last 7, or a long view. */
	data: NewsletterSignups
	last30: SignupTotal | 'loading' | null
}) {
	const { last7, window } = data.totals
	const daily = data.range === '7d' || data.range === '30d'
	const label = viewLabel(data.range)
	return (
		<div className="mt-4 flex flex-col gap-5">
			<div
				className={`border-border bg-border grid gap-px border ${daily ? 'grid-cols-2' : 'grid-cols-3'}`}
			>
				<TotalTile label="New subscribers, last 7 days" total={last7} />
				<TotalTile label="New subscribers, last 30 days" total={last30} />
				{!daily && (
					<TotalTile
						label={
							data.range === 'all'
								? `New subscribers since ${longDayLabel(data.from)}`
								: `New subscribers, last ${label}`
						}
						total={window}
					/>
				)}
			</div>
			<div className="flex flex-col gap-2">
				<h3 className={TYPE.groupLabel}>By source</h3>
				{data.sources.length === 0 ? (
					<p className={TYPE.metaMark}>
						No signups reported in these {data.windowDays} days.
					</p>
				) : (
					<ul className="flex flex-col gap-1">
						{data.sources.map((source) => (
							<li
								key={source}
								className={`${TYPE.meta} flex justify-between gap-3`}
							>
								<span>{signupSourceLabel(source)}</span>
								<span className="tabular-nums">
									{sourceTotal(last7, source)} in 7 days ·{' '}
									{sourceTotal(last30, source)} in 30 days
									{!daily && ` · ${sourceTotal(window, source)} in ${label}`}
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
			<div className="flex flex-col gap-2">
				<h3 className={TYPE.groupLabel}>
					{daily ? 'Daily, newest first (UTC)' : 'Monthly, newest first (UTC)'}
				</h3>
				{daily ? <DailyTable data={data} /> : <MonthlyTable data={data} />}
				{last30 === 'loading' && (
					<p className={TYPE.metaMark}>Loading older days…</p>
				)}
			</div>
		</div>
	)
}

function useSignups(range: SignupRange, enabled: boolean) {
	return useQuery({
		queryKey: ['analytics', 'newsletter/signups', range],
		enabled,
		staleTime: 60_000,
		refetchOnWindowFocus: false,
		retry: false,
		queryFn: async ({ signal }) => {
			const response = await fetch(
				`/api/analytics?surface=newsletter%2Fsignups&range=${range}`,
				{ signal, cache: 'no-store' },
			)
			const body = await response.json()
			if (!response.ok || !body.ok)
				throw new Error('Newsletter signups are unavailable.')
			return body.data as NewsletterSignups
		},
	})
}

const UNAVAILABLE_NOTE = (
	<p className={`${TYPE.meta} text-muted-foreground mt-2`}>
		Newsletter signups are unavailable right now. This is not zero.
	</p>
)

/**
 * The last 7 days load first, because a cold drovr read costs about 0.75 s
 * a day. The 30 days fill in once that settles, so they never compete with
 * it, and a longer view loads only when chosen. Each wider read is merged
 * with the narrower ones day by day, so a week that failed in one read but
 * answered in another still counts. Query owns loading -> success/error. A
 * failed read is unavailable, not 0.
 */
export function NewsletterSignupsPanel({
	initialView = '30d',
}: {
	initialView?: SignupView
} = {}) {
	const [view, setView] = React.useState<SignupView>(initialView)
	const recent = useSignups('7d', true)
	const full = useSignups('30d', !recent.isPending)
	const long = useSignups(
		view === '30d' ? '90d' : view,
		view !== '30d' && !recent.isPending,
	)
	const daily = full.data
		? mergeSignupReads(full.data, recent.data)
		: recent.data
	const last30 = full.data
		? daily!.totals.last30
		: full.isError
			? null
			: 'loading'
	const longData =
		view !== '30d' && long.data
			? mergeSignupReads(long.data, full.data, recent.data)
			: undefined
	const data = view === '30d' ? daily : longData
	return (
		<section
			aria-label="Newsletter signups"
			className="bg-card text-card-foreground border-border rounded-lg border p-4"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-3">
				<h2 className={TYPE.cardTitle}>Newsletter signups</h2>
				<div className={`${TYPE.meta} flex gap-3`} role="group" aria-label="Range">
					{VIEWS.map(({ range, label }) => (
						<button
							key={range}
							type="button"
							onClick={() => setView(range)}
							aria-pressed={view === range}
							className={`focus-visible:ring-ring underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 ${view === range ? 'text-foreground font-medium underline' : 'text-muted-foreground'}`}
						>
							{label}
						</button>
					))}
				</div>
			</div>
			<p className={`${TYPE.metaMark} mt-1`}>
				By UTC day. Counts only.{data && ` ${provenanceLabel(data)}`}
			</p>
			<div aria-live="polite">
				{data ? (
					<NewsletterSignupsView
						data={data}
						last30={view === '30d' ? last30 : data.totals.last30}
					/>
				) : view !== '30d' ? (
					long.isError ? (
						UNAVAILABLE_NOTE
					) : (
						<p className={`${TYPE.meta} text-muted-foreground mt-2`}>
							Loading {viewLabel(view)} of newsletter signups…
						</p>
					)
				) : recent.isPending || (!full.isError && full.isPending) ? (
					<p className={`${TYPE.meta} text-muted-foreground mt-2`}>
						Loading newsletter signups…
					</p>
				) : (
					UNAVAILABLE_NOTE
				)}
			</div>
		</section>
	)
}
