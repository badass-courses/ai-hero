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

interface WatchTimeChartProps {
	data: { date: string; watchTimeMs: number }[]
}

function formatDate(dateStr: string) {
	const d = new Date(dateStr)
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Convert ms to display hours (fractional) */
function msToHours(ms: number): number {
	return ms / 1000 / 60 / 60
}

function formatHours(hours: number): string {
	if (hours >= 1000) return `${(hours / 1000).toFixed(1)}k hrs`
	if (hours >= 1) return `${hours.toFixed(1)} hrs`
	const mins = hours * 60
	return `${mins.toFixed(0)} min`
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
	const hours = payload[0]?.value ?? 0
	return (
		<div className="border-border/50 bg-card rounded-lg border px-3 py-2 shadow-xl">
			<p className="text-muted-foreground text-xs">{formatDate(label)}</p>
			<p className="text-foreground text-lg font-bold tabular-nums">
				{formatHours(hours)}
			</p>
		</div>
	)
}

export function WatchTimeChart({ data }: WatchTimeChartProps) {
	const colors = useChartColors()

	const chartData = useMemo(
		() =>
			data.map((d) => ({
				...d,
				label: formatDate(d.date),
				hours: msToHours(d.watchTimeMs),
			})),
		[data],
	)

	const maxHours = useMemo(
		() => Math.max(...chartData.map((d) => d.hours), 0),
		[chartData],
	)

	return (
		<div className="h-[320px] w-full">
			<ResponsiveContainer width="100%" height="100%">
				<AreaChart
					data={chartData}
					margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
				>
					<defs>
						<linearGradient id="watchTimeGradient" x1="0" y1="0" x2="0" y2="1">
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
						domain={[0, Math.ceil(maxHours * 1.1)]}
						tickFormatter={(v: number) => formatHours(v)}
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
						dataKey="hours"
						stroke={colors.primary}
						strokeWidth={2}
						fill="url(#watchTimeGradient)"
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
