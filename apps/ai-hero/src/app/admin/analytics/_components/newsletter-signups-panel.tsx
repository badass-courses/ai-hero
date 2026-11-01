'use client'

import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { BADGE_OUTLINE, TYPE } from '@/components/landing/type'
import type {
	NewsletterSignups,
	SignupTotal,
} from '@/lib/analytics/newsletter-signups'

const number = new Intl.NumberFormat('en-US')
const UNAVAILABLE = 'unavailable'

const SOURCE_LABELS: Record<string, string> = {
	'ai-hero': 'Site signups',
	kit: 'Kit-only arrivals',
	'list-import': 'Imported lists',
	unknown: 'Unknown source',
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

function sourceTotal(total: SignupTotal, source: string) {
	return total.reportedDays > 0
		? number.format(total.subscribed.bySource[source] ?? 0)
		: UNAVAILABLE
}

function TotalTile({ label, total }: { label: string; total: SignupTotal }) {
	const known = total.reportedDays > 0
	return (
		<div className="bg-card p-3">
			<div className={TYPE.statSm}>
				{known ? number.format(total.subscribed.total) : UNAVAILABLE}
			</div>
			<div className={TYPE.statLabel}>{label}</div>
			{known && <p className={`${TYPE.metaMark} mt-1`}>{coverageLabel(total)}</p>}
			{known && (total.confirmed !== null || total.unsubscribed !== null) && (
				<p className={`${TYPE.metaMark} mt-1`}>
					{total.confirmed !== null &&
						`${number.format(total.confirmed)} confirmed`}
					{total.confirmed !== null && total.unsubscribed !== null && ' · '}
					{total.unsubscribed !== null &&
						`${number.format(total.unsubscribed)} unsubscribed`}
				</p>
			)}
		</div>
	)
}

export function NewsletterSignupsView({ data }: { data: NewsletterSignups }) {
	const { last7, last30 } = data.totals
	const showConfirmed = data.days.some(
		(day) => day.status !== 'unavailable' && day.confirmed !== null,
	)
	const showUnsubscribed = data.days.some(
		(day) => day.status !== 'unavailable' && day.unsubscribed !== null,
	)
	const columns = 2 + data.sources.length + +showConfirmed + +showUnsubscribed
	const cell = (n: number | null | undefined) =>
		n === null || n === undefined ? '–' : number.format(n)
	return (
		<div className="mt-4 flex flex-col gap-5">
			<div className="border-border bg-border grid grid-cols-2 gap-px border">
				<TotalTile label="New subscribers, last 7 days" total={last7} />
				<TotalTile label="New subscribers, last 30 days" total={last30} />
			</div>
			<div className="flex flex-col gap-2">
				<h3 className={TYPE.groupLabel}>By source</h3>
				{data.sources.length === 0 ? (
					<p className={TYPE.metaMark}>No signups reported in these 30 days.</p>
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
									<th className="py-1 pr-3 font-normal">Unsubscribed</th>
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
			</div>
		</div>
	)
}

/** Query owns loading -> success/error. A failed read is unavailable, not 0. */
export function NewsletterSignupsPanel() {
	const signups = useQuery({
		queryKey: ['analytics', 'newsletter/signups'],
		staleTime: 60_000,
		refetchOnWindowFocus: false,
		retry: false,
		queryFn: async ({ signal }) => {
			const response = await fetch(
				'/api/analytics?surface=newsletter%2Fsignups',
				{ signal, cache: 'no-store' },
			)
			const body = await response.json()
			if (!response.ok || !body.ok)
				throw new Error('Newsletter signups are unavailable.')
			return body.data as NewsletterSignups
		},
	})
	return (
		<section
			aria-label="Newsletter signups"
			className="bg-card text-card-foreground border-border rounded-lg border p-4"
		>
			<h2 className={TYPE.cardTitle}>Newsletter signups</h2>
			<p className={`${TYPE.metaMark} mt-1`}>
				From drovr, last 30 UTC days. Counts only.
				{signups.data &&
					` As of ${new Date(signups.data.asOf).toLocaleString('en-US', {
						dateStyle: 'medium',
						timeStyle: 'short',
						timeZone: 'UTC',
					})} UTC.`}
			</p>
			<div aria-live="polite">
				{signups.isPending ? (
					<p className={`${TYPE.meta} text-muted-foreground mt-2`}>
						Loading newsletter signups…
					</p>
				) : signups.isError || !signups.data ? (
					<p className={`${TYPE.meta} text-muted-foreground mt-2`}>
						Newsletter signups are unavailable right now. This is not zero.
					</p>
				) : (
					<NewsletterSignupsView data={signups.data} />
				)}
			</div>
		</section>
	)
}
