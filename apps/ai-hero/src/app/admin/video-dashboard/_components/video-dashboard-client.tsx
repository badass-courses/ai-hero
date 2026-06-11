'use client'

import { useTransition } from 'react'
import type { TimeRange, VideoDashboardData } from '@/lib/mux-data'
import {
	ClockIcon,
	EyeIcon,
	FilmIcon,
	GaugeIcon,
	GlobeIcon,
	TrendingUpIcon,
	UsersIcon,
} from 'lucide-react'
import { parseAsStringLiteral, useQueryState } from 'nuqs'

import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@coursebuilder/ui'

import { CountryChart } from './audience-charts'
import { TimeRangeSelector } from './time-range-selector'
import { TopVideosTable } from './top-videos-table'
import { WatchTimeChart } from './watch-time-chart'

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatWatchTime(ms: number): string {
	const hours = ms / 1000 / 60 / 60
	if (hours >= 1000) return `${(hours / 1000).toFixed(1)}k hrs`
	if (hours >= 1) return `${hours.toFixed(0)} hrs`
	const mins = ms / 1000 / 60
	return `${mins.toFixed(0)} min`
}

function formatScore(score: number): string {
	return `${(score * 100).toFixed(1)}%`
}

// ─── Stat Card ───────────────────────────────────────────────────────────────

function StatCard({
	label,
	value,
	subtitle,
	icon: Icon,
}: {
	label: string
	value: string
	subtitle?: string
	icon: React.ComponentType<{ className?: string }>
	accent?: boolean
}) {
	return (
		<Card className="p-5">
			<div className="flex items-center justify-between">
				<span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
					{label}
				</span>
				<Icon className="text-muted-foreground/50 h-4 w-4" />
			</div>
			<div className="mt-2">
				<span className="text-foreground text-2xl font-bold tracking-tight">
					{value}
				</span>
			</div>
			{subtitle && (
				<p className="text-muted-foreground mt-1 text-xs">{subtitle}</p>
			)}
		</Card>
	)
}

// ─── URL State Parsers ───────────────────────────────────────────────────────

const rangeParser = parseAsStringLiteral([
	'7:days',
	'30:days',
	'90:days',
] as const).withDefault('30:days')

// ─── Main Dashboard ──────────────────────────────────────────────────────────

export function VideoDashboardClient({
	data,
	timeRange: initialTimeRange,
}: {
	data: VideoDashboardData
	timeRange: TimeRange
}) {
	const [range, setRange] = useQueryState('range', rangeParser)
	const [isPending, startTransition] = useTransition()

	// The SSR data matches whatever the server parsed; client takes over via nuqs
	const activeRange = range

	function handleRangeChange(newRange: TimeRange) {
		startTransition(() => {
			setRange(newRange)
		})
	}

	const rangeLabel =
		activeRange === '7:days'
			? '7 days'
			: activeRange === '90:days'
				? '90 days'
				: '30 days'

	return (
		<div className="flex flex-col gap-5 lg:gap-10">
			{/* Header */}
			<div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
				<div className="flex flex-col gap-2">
					<h1 className="font-heading text-xl font-bold sm:text-3xl">
						Video Analytics
					</h1>
					<p className="text-muted-foreground">Mux Data · Last {rangeLabel}</p>
				</div>
				<TimeRangeSelector
					current={activeRange}
					isPending={isPending}
					onRangeChange={handleRangeChange}
				/>
			</div>

			{/* Content — fades when loading new time range */}
			<div
				className={`flex flex-col gap-5 transition-opacity duration-200 lg:gap-10 ${isPending ? 'pointer-events-none opacity-50' : ''}`}
			>
				{/* Overview Cards */}
				<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
					<StatCard
						label="Total Views"
						value={data.overview.totalViews.toLocaleString()}
						icon={EyeIcon}
					/>
					<StatCard
						label="Watch Time"
						value={formatWatchTime(data.overview.totalWatchTimeMs)}
						subtitle={`${formatWatchTime(data.overview.totalPlayingTimeMs)} playing`}
						icon={ClockIcon}
					/>
					<StatCard
						label="Experience Score"
						value={formatScore(data.overview.viewerExperienceScore)}
						subtitle={
							data.overview.globalExperienceScore
								? `Global avg: ${formatScore(data.overview.globalExperienceScore)}`
								: undefined
						}
						icon={GaugeIcon}
					/>
					<StatCard
						label="Unique Viewers"
						value={data.overview.uniqueViewers.toLocaleString()}
						subtitle={`${(data.overview.totalViews / Math.max(data.overview.uniqueViewers, 1)).toFixed(1)} views per viewer`}
						icon={UsersIcon}
					/>
				</div>

				{/* Watch Time Over Time */}
				<Card className="overflow-hidden">
					<CardHeader>
						<div className="flex items-center gap-5">
							<TrendingUpIcon className="text-muted-foreground h-4 w-4" />
							<div className="space-y-1">
								<CardTitle className="text-lg font-bold">Watch Time</CardTitle>
								<CardDescription>Total watch time per day</CardDescription>
							</div>
						</div>
					</CardHeader>
					<CardContent className="pb-4">
						<WatchTimeChart data={data.watchTimeSeries} />
					</CardContent>
				</Card>

				{/* Top Videos */}
				<Card className="overflow-hidden">
					<CardHeader>
						<div className="flex items-center gap-5">
							<FilmIcon className="text-muted-foreground h-4 w-4" />
							<div className="space-y-1">
								<CardTitle className="text-lg font-bold">Top Videos</CardTitle>
								<CardDescription>
									Ranked by views · {data.topVideos.length} videos
								</CardDescription>
							</div>
						</div>
					</CardHeader>
					<CardContent>
						<TopVideosTable
							videos={data.topVideos}
							totalViews={data.overview.totalViews}
							timeRange={activeRange}
						/>
					</CardContent>
				</Card>

				{/* Countries */}
				<Card className="overflow-hidden">
					<CardHeader>
						<div className="flex items-center gap-5">
							<GlobeIcon className="text-muted-foreground h-4 w-4" />
							<div className="space-y-1">
								<CardTitle className="text-lg font-bold">
									Top Countries
								</CardTitle>
								<CardDescription>Where your viewers are</CardDescription>
							</div>
						</div>
					</CardHeader>
					<CardContent>
						<CountryChart data={data.countries} />
					</CardContent>
				</Card>
			</div>
			{/* end content fade wrapper */}
		</div>
	)
}
