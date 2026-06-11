import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { getVideoDashboardData, type TimeRange } from '@/lib/mux-data'
import { getServerAuthSession } from '@/server/auth'
import { Loader2 } from 'lucide-react'

import { VideoDashboardClient } from './_components/video-dashboard-client'

const VALID_RANGES = new Set(['7:days', '30:days', '90:days'])

function parseTimeRange(raw?: string): TimeRange {
	if (raw && VALID_RANGES.has(raw)) return raw as TimeRange
	return '30:days'
}

async function DashboardContent({ timeRange }: { timeRange: TimeRange }) {
	const data = await getVideoDashboardData(timeRange)
	return <VideoDashboardClient data={data} timeRange={timeRange} />
}

function DashboardSkeleton() {
	return (
		<div className="flex flex-1 items-center justify-center py-20">
			<div className="flex flex-col items-center gap-3">
				<Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
				<p className="text-muted-foreground text-sm">
					Loading video analytics…
				</p>
			</div>
		</div>
	)
}

export default async function VideoDashboardPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
	const { ability } = await getServerAuthSession()
	if (ability.cannot('manage', 'all')) {
		notFound()
	}

	const params = await searchParams
	const timeRange = parseTimeRange(
		Array.isArray(params.range) ? params.range[0] : params.range,
	)

	return (
		<main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 py-10 lg:gap-10">
			<Suspense fallback={<DashboardSkeleton />}>
				<DashboardContent timeRange={timeRange} />
			</Suspense>
		</main>
	)
}
