'use client'

import { useCallback, useState, useTransition } from 'react'
import type {
	TimeRange,
	VideoDashboardData,
	VideoDetailBreakdowns,
	VideoTableRange,
} from '@/lib/mux-data'
import {
	ChevronDownIcon,
	ChevronRightIcon,
	GlobeIcon,
	Loader2,
	TrendingUpIcon,
} from 'lucide-react'
import { parseAsStringLiteral, useQueryState } from 'nuqs'

import {
	fetchVideoBreakdown,
	fetchVideoDetail,
	type VideoSortBy,
} from '../actions'
import { useChartColors } from './use-chart-colors'
import { ViewsChart } from './views-chart'

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatWatchTime(ms: number): string {
	const hours = ms / 1000 / 60 / 60
	if (hours >= 1000) return `${(hours / 1000).toFixed(1)}k hrs`
	if (hours >= 1) return `${hours.toFixed(0)} hrs`
	const mins = ms / 1000 / 60
	return `${mins.toFixed(0)} min`
}

function avgWatchTime(watchTimeMs: number, views: number): string {
	if (views === 0) return '—'
	const avgMs = watchTimeMs / views
	const mins = avgMs / 1000 / 60
	if (mins >= 60) {
		const h = Math.floor(mins / 60)
		const m = Math.round(mins % 60)
		return `${h}h ${m}m`
	}
	return `${mins.toFixed(1)}m`
}

// ─── Country flag helper ─────────────────────────────────────────────────────

const COUNTRY_NAMES: Record<string, string> = {
	US: 'United States',
	GB: 'United Kingdom',
	IN: 'India',
	DE: 'Germany',
	BR: 'Brazil',
	ES: 'Spain',
	PL: 'Poland',
	NL: 'Netherlands',
	CA: 'Canada',
	AR: 'Argentina',
	FR: 'France',
	AU: 'Australia',
	IT: 'Italy',
	SE: 'Sweden',
	JP: 'Japan',
}

function countryFlag(code: string): string {
	try {
		return code
			.toUpperCase()
			.split('')
			.map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
			.join('')
	} catch {
		return '🌍'
	}
}

// ─── Time Range Tabs ─────────────────────────────────────────────────────────

const TABLE_RANGES: { value: VideoTableRange; label: string }[] = [
	{ value: '24:hours', label: '24h' },
	{ value: '7:days', label: '7d' },
	{ value: '30:days', label: '30d' },
	{ value: '90:days', label: '90d' },
]

// ─── Expanded Detail Panel ───────────────────────────────────────────────────

function VideoDetailPanel({ detail }: { detail: VideoDetailBreakdowns }) {
	return (
		<div className="bg-muted/30 border-border grid gap-5 border-t px-4 py-5 lg:grid-cols-3">
			{/* Mini timeseries */}
			<div className="lg:col-span-2">
				<div className="mb-2 flex items-center gap-2">
					<TrendingUpIcon className="text-muted-foreground h-3.5 w-3.5" />
					<span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
						Views over time
					</span>
				</div>
				<div className="h-[160px]">
					<ViewsChart data={detail.timeseries} />
				</div>
			</div>

			{/* Country breakdown */}
			<div className="flex flex-col gap-4">
				<div>
					<div className="mb-2 flex items-center gap-2">
						<GlobeIcon className="text-muted-foreground h-3.5 w-3.5" />
						<span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
							Top Countries
						</span>
					</div>
					<div className="flex flex-col gap-1.5">
						{detail.countries.slice(0, 5).map((c, i) => (
							<div
								key={i}
								className="flex items-center justify-between text-sm"
							>
								<span className="text-muted-foreground">
									{countryFlag(c.country)}{' '}
									{COUNTRY_NAMES[c.country] || c.country}
								</span>
								<span className="text-foreground font-medium tabular-nums">
									{c.views.toLocaleString()}
								</span>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	)
}

// ─── Video Row ───────────────────────────────────────────────────────────────

function VideoRow({
	video,
	index,
	totalViews,
	timeRange,
}: {
	video: VideoDashboardData['topVideos'][number]
	index: number
	totalViews: number
	timeRange: TimeRange
}) {
	const [expanded, setExpanded] = useState(false)
	const [detail, setDetail] = useState<VideoDetailBreakdowns | null>(null)
	const [isPending, startTransition] = useTransition()

	const pct = totalViews > 0 ? (video.views / totalViews) * 100 : 0

	const handleToggle = useCallback(() => {
		if (expanded) {
			setExpanded(false)
			return
		}

		setExpanded(true)

		if (!detail) {
			startTransition(async () => {
				const result = await fetchVideoDetail(video.title, timeRange)
				if (result) setDetail(result)
			})
		}
	}, [expanded, detail, video.title, timeRange])

	return (
		<>
			<tr
				className="hover:bg-muted/30 group cursor-pointer transition-colors"
				onClick={handleToggle}
			>
				<td className="py-3 pl-3 pr-2">
					{expanded ? (
						<ChevronDownIcon className="text-muted-foreground h-4 w-4" />
					) : (
						<ChevronRightIcon className="text-muted-foreground h-4 w-4" />
					)}
				</td>
				<td className="text-muted-foreground py-3 pr-4 text-sm tabular-nums">
					{index + 1}
				</td>
				<td className="max-w-xs truncate py-3 pr-4 text-sm font-medium">
					<span className="group-hover:text-primary transition-colors">
						{video.title}
					</span>
				</td>
				<td className="text-foreground py-3 pr-4 text-right text-sm font-semibold tabular-nums">
					{video.views.toLocaleString()}
				</td>
				<td className="text-muted-foreground py-3 pr-4 text-right text-sm tabular-nums">
					{formatWatchTime(video.watchTimeMs)}
				</td>
				<td className="text-muted-foreground hidden py-3 pr-4 text-right text-sm tabular-nums sm:table-cell">
					{avgWatchTime(video.watchTimeMs, video.views)}
				</td>
				<td className="hidden py-3 sm:table-cell">
					<div className="flex items-center gap-2">
						<div className="bg-muted/50 relative h-1.5 w-20 overflow-hidden rounded-full">
							<div
								className="bg-primary/60 absolute inset-y-0 left-0 rounded-full transition-all"
								style={{ width: `${Math.min(pct, 100)}%` }}
							/>
						</div>
						<span className="text-muted-foreground text-xs tabular-nums">
							{pct.toFixed(1)}%
						</span>
					</div>
				</td>
			</tr>
			{expanded && (
				<tr>
					<td colSpan={7} className="p-0">
						{isPending ? (
							<div className="flex items-center justify-center py-8">
								<Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
							</div>
						) : detail ? (
							<VideoDetailPanel detail={detail} />
						) : (
							<div className="text-muted-foreground py-6 text-center text-sm">
								Failed to load details
							</div>
						)}
					</td>
				</tr>
			)}
		</>
	)
}

// ─── Top Videos Table ────────────────────────────────────────────────────────

const INITIAL_SHOW = 10

export function TopVideosTable({
	videos: initialVideos,
	totalViews: initialTotalViews,
	timeRange: pageTimeRange,
}: {
	videos: VideoDashboardData['topVideos']
	totalViews: number
	timeRange: TimeRange
}) {
	const [showAll, setShowAll] = useState(false)

	// URL-persisted state via nuqs
	const [sortBy, setSortBy] = useQueryState(
		'sort',
		parseAsStringLiteral(['views', 'watch_time'] as const).withDefault('views'),
	)
	const initialRange: VideoTableRange =
		pageTimeRange === '7:days'
			? '7:days'
			: pageTimeRange === '90:days'
				? '90:days'
				: '30:days'
	const [activeRange, setActiveRange] = useQueryState(
		'tableRange',
		parseAsStringLiteral([
			'24:hours',
			'7:days',
			'30:days',
			'90:days',
		] as const).withDefault(initialRange),
	)

	const [videos, setVideos] =
		useState<VideoDashboardData['topVideos']>(initialVideos)
	const [totalViews, setTotalViews] = useState(initialTotalViews)
	const [isPending, startTransition] = useTransition()

	function fetchAndSet(range: VideoTableRange, sort: VideoSortBy) {
		startTransition(async () => {
			const result = await fetchVideoBreakdown(range, sort)
			setVideos(result)
			setTotalViews(result.reduce((sum, v) => sum + v.views, 0))
		})
	}

	function handleRangeChange(range: VideoTableRange) {
		setActiveRange(range)
		setShowAll(false)

		// If this is the initial page range AND default sort, use SSR data
		if (range === initialRange && sortBy === 'views') {
			setVideos(initialVideos)
			setTotalViews(initialTotalViews)
			return
		}

		fetchAndSet(range, sortBy)
	}

	function handleSortChange(sort: VideoSortBy) {
		setSortBy(sort)
		setShowAll(false)

		// If initial range + views sort, use SSR data
		if (activeRange === initialRange && sort === 'views') {
			setVideos(initialVideos)
			setTotalViews(initialTotalViews)
			return
		}

		fetchAndSet(activeRange, sort)
	}

	const visible = showAll ? videos : videos.slice(0, INITIAL_SHOW)
	const hasMore = videos.length > INITIAL_SHOW

	return (
		<div>
			{/* Controls: Range tabs + Sort toggle */}
			<div className="mb-4 flex flex-wrap items-center gap-3">
				{isPending && (
					<Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
				)}
				<div className="border-border/50 bg-muted/30 inline-flex items-center gap-0.5 rounded-lg border p-1">
					{TABLE_RANGES.map(({ value, label }) => (
						<button
							key={value}
							onClick={() => handleRangeChange(value)}
							disabled={isPending}
							className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
								activeRange === value
									? 'bg-primary text-primary-foreground shadow-sm'
									: 'text-muted-foreground hover:text-foreground hover:bg-muted'
							} ${isPending ? 'cursor-wait opacity-60' : ''}`}
						>
							{label}
						</button>
					))}
				</div>

				<div className="border-border/50 bg-muted/30 inline-flex items-center gap-0.5 rounded-lg border p-1">
					{(
						[
							{ value: 'views', label: 'Views' },
							{ value: 'watch_time', label: 'Watch Time' },
						] as const
					).map(({ value, label }) => (
						<button
							key={value}
							onClick={() => handleSortChange(value)}
							disabled={isPending}
							className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
								sortBy === value
									? 'bg-primary text-primary-foreground shadow-sm'
									: 'text-muted-foreground hover:text-foreground hover:bg-muted'
							} ${isPending ? 'cursor-wait opacity-60' : ''}`}
						>
							{label}
						</button>
					))}
				</div>
			</div>

			{/* Table */}
			<div
				className={`transition-opacity duration-200 ${isPending ? 'pointer-events-none opacity-50' : ''}`}
			>
				<div className="overflow-x-auto">
					<table className="w-full">
						<thead>
							<tr className="text-muted-foreground border-border border-b text-left text-xs uppercase tracking-wider">
								<th className="w-8 pb-3 pl-3 pr-2"></th>
								<th className="pb-3 pr-4 font-medium">#</th>
								<th className="pb-3 pr-4 font-medium">Title</th>
								<th className="pb-3 pr-4 text-right font-medium">Views</th>
								<th className="pb-3 pr-4 text-right font-medium">Watch Time</th>
								<th className="hidden pb-3 pr-4 text-right font-medium sm:table-cell">
									Avg / View
								</th>
								<th className="hidden pb-3 font-medium sm:table-cell">Share</th>
							</tr>
						</thead>
						<tbody className="divide-border divide-y">
							{visible.map((video, i) => (
								<VideoRow
									key={video.title}
									video={video}
									index={i}
									totalViews={totalViews}
									timeRange={
										activeRange === '24:hours' ? '7:days' : activeRange
									}
								/>
							))}
						</tbody>
					</table>
				</div>
				{hasMore && (
					<div className="border-border border-t pt-3 text-center">
						<button
							onClick={() => setShowAll(!showAll)}
							className="text-muted-foreground hover:text-foreground text-sm font-medium transition-colors"
						>
							{showAll ? 'Show less' : `Show all ${videos.length} videos`}
						</button>
					</div>
				)}
			</div>
		</div>
	)
}
