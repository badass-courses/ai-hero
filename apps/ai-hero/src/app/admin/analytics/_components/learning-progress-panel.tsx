'use client'

import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BADGE_NEUTRAL, BADGE_OUTLINE, TYPE } from '@/components/landing/type'
import type {
	LearningFunnelRow,
	LearningProgress,
} from '@/lib/analytics/learning-progress'

export type LearningProductOption = LearningProgress['product']

const number = new Intl.NumberFormat('en-US')

/** "N of M" plus a whole percent. Zero signed-in learners has no share. */
export function shareOf(count: number, total: number) {
	return {
		label: `${number.format(count)} of ${number.format(total)}`,
		percent: total > 0 ? Math.round((count / total) * 100) : null,
	}
}

function lockedLabel(row: LearningFunnelRow) {
	if (row.availability.status !== 'locked') return null
	if (row.availability.reason === 'unpublished') return 'Locked · draft'
	return row.startsAt
		? `Locked · opens ${new Date(row.startsAt).toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
				timeZone: 'America/Los_Angeles',
			})}`
		: 'Locked'
}

export function Tiles({
	tiles,
}: {
	tiles: Array<[label: string, value: number]>
}) {
	return (
		<div
			className={`border-border bg-border grid grid-cols-2 gap-px border ${tiles.length === 6 ? 'sm:grid-cols-3 lg:grid-cols-6' : 'sm:grid-cols-4'}`}
		>
			{tiles.map(([label, value]) => (
				<div key={label} className="bg-card p-3">
					<div className={TYPE.statSm}>{number.format(value)}</div>
					<div className={TYPE.statLabel}>{label}</div>
				</div>
			))}
		</div>
	)
}

function ShareBar({
	label,
	count,
	total,
}: {
	label: string
	count: number
	total: number
}) {
	const share = shareOf(count, total)
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<div className={`${TYPE.metaMark} flex justify-between gap-2`}>
				<span>{label}</span>
				<span className="tabular-nums">
					{share.label}
					{share.percent === null ? '' : ` · ${share.percent}%`}
				</span>
			</div>
			<div className="bg-foreground/10 h-1.5 w-full" aria-hidden>
				<div
					className="bg-foreground/70 h-full"
					style={{ width: `${share.percent ?? 0}%` }}
				/>
			</div>
		</div>
	)
}

export function FunnelRow({
	row,
	denominator,
}: {
	row: LearningFunnelRow
	denominator: number
}) {
	const locked = lockedLabel(row)
	return (
		<li
			className={`border-[color:var(--ah-line-soft)] grid gap-2 border-t py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:gap-6 ${row.kind === 'section' ? 'md:pl-5' : ''}`}
		>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<span
					className={
						row.kind === 'workshop'
							? TYPE.cardTitle
							: `${TYPE.meta} text-muted-foreground`
					}
				>
					{row.title}
				</span>
				<span className={`${TYPE.metaMark}`}>
					{row.requiredLessons} lessons
				</span>
				{locked && (
					<span className={`${TYPE.badge} ${BADGE_OUTLINE}`}>{locked}</span>
				)}
			</div>
			{row.requiredLessons === 0 ? (
				<p className={TYPE.metaMark}>No required lessons yet.</p>
			) : locked && row.started === 0 ? (
				<p className={TYPE.metaMark}>Not open to learners yet.</p>
			) : (
				<div className="grid gap-2 sm:grid-cols-2">
					<ShareBar label="Started" count={row.started} total={denominator} />
					<ShareBar
						label="Completed"
						count={row.completed}
						total={denominator}
					/>
				</div>
			)}
		</li>
	)
}

export function LearningProgressView({ data }: { data: LearningProgress }) {
	const { roster, funnel, activity } = data
	const denominator = funnel.denominator.count
	return (
		<div className="mt-4 flex flex-col gap-5">
			<div className="flex flex-col gap-2">
				<h3 className={TYPE.groupLabel}>Roster</h3>
				<Tiles
					tiles={[
						['Learners', roster.learners],
						['Signed in', roster.signedIn],
						['Never signed in', roster.neverSignedIn],
						['Open team seats', roster.teamSeatsUnredeemed],
						['Refunded', roster.removed.refunded],
						['Transferred away', roster.removed.transferredAway],
					]}
				/>
				<ShareBar
					label="Team seat learners"
					count={roster.bySource.teamSeat}
					total={roster.learners}
				/>
			</div>
			<div className="flex flex-col gap-2">
				<h3 className={TYPE.groupLabel}>Activity</h3>
				<Tiles
					tiles={[
						['Lessons done 24h', activity.lessonsCompleted24h],
						['Lessons done 7d', activity.lessonsCompleted7d],
						['Active learners 7d', activity.activeLearners7d],
						['All completions', activity.totalLessonCompletions],
					]}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<h3 className={TYPE.groupLabel}>Workshops</h3>
				<p className={TYPE.metaMark}>
					Every share is out of {number.format(denominator)} signed-in learners.
					A learner can start a later workshop without the earlier ones.
				</p>
				{funnel.rows.length === 0 ? (
					<p className={`${TYPE.meta} text-muted-foreground mt-2`}>
						This product has no workshops.
					</p>
				) : (
					<ol className="mt-2">
						{funnel.rows.map((row) => (
							<FunnelRow key={row.id} row={row} denominator={denominator} />
						))}
					</ol>
				)}
			</div>
		</div>
	)
}

/** Query owns loading -> success/error and cancellation on product changes. */
export function LearningProgressPanel({
	products,
}: {
	products: LearningProductOption[]
}) {
	const [productId, setProductId] = useState(products[0]?.id ?? '')
	const progress = useQuery<LearningProgress>({
		queryKey: ['analytics', 'learning/progress', productId],
		enabled: productId !== '',
		staleTime: 60_000,
		// Follows the server cache window, so the refresh copy holds.
		refetchInterval: (query) =>
			(query.state.data?.refreshSeconds ?? 300) * 1000,
		refetchOnWindowFocus: false,
		retry: false,
		queryFn: async ({ signal }) => {
			const response = await fetch(
				`/api/analytics?surface=learning%2Fprogress&productId=${encodeURIComponent(productId)}`,
				{ signal, cache: 'no-store' },
			)
			const body = await response.json()
			if (!response.ok || !body.ok)
				throw new Error('Learner progress is temporarily unavailable.')
			return body.data as LearningProgress
		},
	})
	return (
		<section
			aria-label="Learner progress"
			className="bg-card text-card-foreground border-border rounded-lg border p-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<h2 className={TYPE.cardTitle}>Learner progress</h2>
					<span className={`${TYPE.badge} ${BADGE_NEUTRAL}`}>Aggregate</span>
				</div>
				{products.length > 0 && (
					<label className={`${TYPE.meta} flex items-center gap-2`}>
						<span className="text-muted-foreground">Product</span>
						<select
							value={productId}
							onChange={(event) => setProductId(event.target.value)}
							className="border-input bg-card text-foreground focus-visible:ring-ring rounded-[6px] border px-2 py-1 focus-visible:outline-none focus-visible:ring-2"
						>
							{products.map((product) => (
								<option key={product.id} value={product.id}>
									{product.name}
								</option>
							))}
						</select>
					</label>
				)}
			</div>
			<div className={`${TYPE.metaMark} mt-2`} aria-live="polite">
				{products.length === 0
					? 'No course or cohort products are available.'
					: progress.isPending
						? 'Loading learner progress…'
						: progress.isError
							? 'Learner progress is temporarily unavailable.'
							: `As of ${new Date(progress.data.asOf).toLocaleString('en-US', {
									dateStyle: 'medium',
									timeStyle: 'short',
								})} · refreshes every ${progress.data.refreshSeconds / 60} minutes`}
			</div>
			{progress.data && !progress.isError && (
				<LearningProgressView data={progress.data} />
			)}
		</section>
	)
}
