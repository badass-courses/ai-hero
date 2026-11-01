'use client'

import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { BADGE_OUTLINE, TYPE } from '@/components/landing/type'
import type {
	NewsletterSignups,
	SignupTotal,
	SignupWindowDays,
} from '@/lib/analytics/newsletter-signups'

const number = new Intl.NumberFormat('en-US')
const UNAVAILABLE = 'unavailable'

// unknown and unattributed are drovr's reserved keys and show as they are.
const SOURCE_LABELS: Record<string, string> = {
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

export function NewsletterSignupsView({
	data,
	last30,
}: {
	/** The widest read so far: 30 days once loaded, else the last 7. */
	data: NewsletterSignups
	last30: SignupTotal | 'loading' | null
}) {
	const { last7 } = data.totals
	const showConfirmed = data.days.some(
		(day) => day.status !== 'unavailable' && day.confirmed !== null,
	)
	const showUnsubscribed = data.days.some(
		(day) => day.status !== 'unavailable' && day.unsubscribed !== null,
	)
	const columns = 2 + data.sources.length + +showConfirmed + +showUnsubscribed
	const cell = (n: number | null) => (n === null ? '–' : number.format(n))
	return (
		<div className="mt-4 flex flex-col gap-5">
			<div className="border-border bg-border grid grid-cols-2 gap-px border">
				<TotalTile label="New subscribers, last 7 days" total={last7} />
				<TotalTile label="New subscribers, last 30 days" total={last30} />
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
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
			<div className="flex flex-col gap-2">
				<h3 className={TYPE.groupLabel}>Daily, newest first (UTC)</h3>
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
											{UNAVAILABLE}
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
				{last30 === 'loading' && (
					<p className={TYPE.metaMark}>Loading older days…</p>
				)}
			</div>
		</div>
	)
}

function useSignups(days: SignupWindowDays, enabled: boolean) {
	return useQuery({
		queryKey: ['analytics', 'newsletter/signups', `${days}d`],
		enabled,
		staleTime: 60_000,
		refetchOnWindowFocus: false,
		retry: false,
		queryFn: async ({ signal }) => {
			const response = await fetch(
				`/api/analytics?surface=newsletter%2Fsignups&range=${days}d`,
				{ signal, cache: 'no-store' },
			)
			const body = await response.json()
			if (!response.ok || !body.ok)
				throw new Error('Newsletter signups are unavailable.')
			return body.data as NewsletterSignups
		},
	})
}

/**
 * The last 7 days load first, because a cold drovr read costs about 0.75 s
 * a day. The older days fill in once that settles, so they never compete
 * with it. Query owns loading -> success/error. A failed read is
 * unavailable, not 0.
 */
export function NewsletterSignupsPanel() {
	const recent = useSignups(7, true)
	const full = useSignups(30, !recent.isPending)
	const data = full.data ?? recent.data
	const last30 = full.data
		? full.data.totals.last30
		: full.isError
			? null
			: 'loading'
	return (
		<section
			aria-label="Newsletter signups"
			className="bg-card text-card-foreground border-border rounded-lg border p-4"
		>
			<h2 className={TYPE.cardTitle}>Newsletter signups</h2>
			<p className={`${TYPE.metaMark} mt-1`}>
				From drovr, by UTC day. Counts only.
				{data &&
					` As of ${new Date(data.asOf).toLocaleString('en-US', {
						dateStyle: 'medium',
						timeStyle: 'short',
						timeZone: 'UTC',
					})} UTC.`}
			</p>
			<div aria-live="polite">
				{data ? (
					<NewsletterSignupsView data={data} last30={last30} />
				) : recent.isPending || (!full.isError && full.isPending) ? (
					<p className={`${TYPE.meta} text-muted-foreground mt-2`}>
						Loading newsletter signups…
					</p>
				) : (
					<p className={`${TYPE.meta} text-muted-foreground mt-2`}>
						Newsletter signups are unavailable right now. This is not zero.
					</p>
				)}
			</div>
		</section>
	)
}
