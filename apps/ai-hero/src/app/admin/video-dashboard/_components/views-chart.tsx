'use client'

import { useMemo } from 'react'
import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from 'recharts'

import { useChartColors } from './use-chart-colors'

interface ViewsChartProps {
	data: { date: string; views: number }[]
}

function formatDate(dateStr: string) {
	const d = new Date(dateStr)
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function CustomTooltip({
	active,
	payload,
	label,
}: {
	active?: boolean
	payload?: { value: number }[]
	label?: string
}) {
	if (!active || !payload?.length || !label) return null
	return (
		<div className="border-border/50 bg-card rounded-lg border px-3 py-2 shadow-xl">
			<p className="text-muted-foreground text-xs">{formatDate(label)}</p>
			<p className="text-foreground text-lg font-bold tabular-nums">
				{payload[0]?.value?.toLocaleString()} views
			</p>
		</div>
	)
}

export function ViewsChart({ data }: ViewsChartProps) {
	const colors = useChartColors()

	const chartData = useMemo(
		() => data.map((d) => ({ ...d, label: formatDate(d.date) })),
		[data],
	)

	const maxViews = useMemo(
		() => Math.max(...data.map((d) => d.views), 0),
		[data],
	)

	return (
		<div className="h-[320px] w-full">
			<ResponsiveContainer width="100%" height="100%">
				<AreaChart
					data={chartData}
					margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
				>
					<defs>
						<linearGradient id="viewsGradient" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor={colors.primary} stopOpacity={0.3} />
							<stop offset="100%" stopColor={colors.primary} stopOpacity={0} />
						</linearGradient>
					</defs>
					<CartesianGrid
						strokeDasharray="3 3"
						stroke={colors.gridLine}
						vertical={false}
					/>
					<XAxis
						dataKey="date"
						tickFormatter={formatDate}
						tick={{ fill: colors.mutedForeground, fontSize: 11 }}
						axisLine={{ stroke: colors.gridLine }}
						tickLine={false}
						interval="preserveStartEnd"
						minTickGap={40}
					/>
					<YAxis
						tick={{ fill: colors.mutedForeground, fontSize: 11 }}
						axisLine={false}
						tickLine={false}
						domain={[0, Math.ceil(maxViews * 1.1)]}
						tickFormatter={(v: number) =>
							v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
						}
					/>
					<Tooltip
						content={<CustomTooltip />}
						cursor={{
							stroke: colors.primary,
							strokeWidth: 1,
							strokeDasharray: '4 4',
						}}
					/>
					<Area
						type="monotone"
						dataKey="views"
						stroke={colors.primary}
						strokeWidth={2}
						fill="url(#viewsGradient)"
						dot={false}
						activeDot={{
							r: 5,
							fill: colors.primary,
							stroke: colors.cardBg,
							strokeWidth: 2,
						}}
					/>
				</AreaChart>
			</ResponsiveContainer>
		</div>
	)
}
