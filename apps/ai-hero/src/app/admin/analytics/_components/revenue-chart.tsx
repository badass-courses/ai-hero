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

import { useChartColors } from '../../video-dashboard/_components/use-chart-colors'

interface DayData {
	date: string
	revenue: number
	count: number
}

interface RevenueChartProps {
	data: DayData[]
	previousData?: DayData[]
}

function formatDate(dateStr: string) {
	const d = new Date(dateStr + 'T00:00:00')
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatCurrency(value: number): string {
	if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`
	return `$${value.toFixed(0)}`
}

function CustomTooltip({
	active,
	payload,
	label,
}: {
	active?: boolean
	payload?: { dataKey: string; value: number; payload: MergedDay }[]
	label?: string
}) {
	if (!active || !payload?.length || !label) return null

	const merged = payload[0]?.payload
	if (!merged) return null

	const current = merged.revenue ?? 0
	const previous = merged.prevRevenue ?? 0
	const hasPrev = previous > 0

	let delta = ''
	let deltaColor = ''
	if (hasPrev && current > 0) {
		const pct = ((current - previous) / previous) * 100
		delta = pct >= 0 ? `+${pct.toFixed(0)}%` : `${pct.toFixed(0)}%`
		deltaColor = pct >= 0 ? 'text-emerald-500' : 'text-red-400'
	}

	return (
		<div className="border-border/50 bg-card rounded-lg border px-3 py-2 shadow-xl">
			<p className="text-muted-foreground text-xs">{formatDate(label)}</p>
			<div className="mt-1 flex items-baseline gap-2">
				<p className="text-foreground text-lg font-bold tabular-nums">
					$
					{current.toLocaleString(undefined, {
						minimumFractionDigits: 0,
						maximumFractionDigits: 0,
					})}
				</p>
				{delta && (
					<span className={`text-xs font-semibold ${deltaColor}`}>{delta}</span>
				)}
			</div>
			<p className="text-muted-foreground text-xs">
				{merged.count ?? 0} purchases
			</p>
			{hasPrev && (
				<p className="text-muted-foreground border-border/30 mt-1 border-t pt-1 text-[11px]">
					prev: $
					{previous.toLocaleString(undefined, {
						minimumFractionDigits: 0,
						maximumFractionDigits: 0,
					})}{' '}
					· {merged.prevCount ?? 0} purchases
				</p>
			)}
		</div>
	)
}

interface MergedDay {
	date: string
	revenue: number
	count: number
	prevRevenue: number | null
	prevCount: number | null
}

export function RevenueChart({ data, previousData = [] }: RevenueChartProps) {
	const colors = useChartColors()

	const merged = useMemo<MergedDay[]>(() => {
		if (previousData.length === 0) {
			return data.map((d) => ({
				...d,
				prevRevenue: null,
				prevCount: null,
			}))
		}

		// Align previous period by day offset (day 0 = start of each period)
		return data.map((d, i) => {
			const prev = previousData[i]
			return {
				...d,
				prevRevenue: prev?.revenue ?? null,
				prevCount: prev?.count ?? null,
			}
		})
	}, [data, previousData])

	const maxRevenue = useMemo(
		() =>
			Math.max(
				...merged.map((d) => d.revenue),
				...merged.map((d) => d.prevRevenue ?? 0),
				0,
			),
		[merged],
	)

	// Use log scale when the max is >10x the median — prevents spikes from crushing everything
	const nonZeroVals = useMemo(
		() =>
			merged
				.map((d) => d.revenue)
				.filter((v) => v > 0)
				.sort((a, b) => a - b),
		[merged],
	)
	const useLog = useMemo(() => {
		if (nonZeroVals.length < 3) return false
		const median = nonZeroVals[Math.floor(nonZeroVals.length / 2)]!
		return maxRevenue > median * 10
	}, [nonZeroVals, maxRevenue])
	const logFloor =
		nonZeroVals.length > 0 ? Math.floor(nonZeroVals[0]! * 0.7) : 100

	const hasPrev = previousData.length > 0

	return (
		<div className="h-[280px] w-full">
			<ResponsiveContainer width="100%" height="100%">
				<AreaChart
					data={merged}
					margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
				>
					<defs>
						<linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
							<stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
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
						scale={useLog ? 'log' : 'auto'}
						domain={
							useLog ? [logFloor, 'auto'] : [0, Math.ceil(maxRevenue * 1.1)]
						}
						allowDataOverflow={useLog}
						tickFormatter={formatCurrency}
					/>
					<Tooltip
						content={<CustomTooltip />}
						cursor={{
							stroke: '#22c55e',
							strokeWidth: 1,
							strokeDasharray: '4 4',
						}}
					/>
					{hasPrev && (
						<Area
							type="linear"
							dataKey="prevRevenue"
							stroke={colors.mutedForeground}
							strokeWidth={1.5}
							strokeDasharray="4 3"
							fill="none"
							dot={false}
							activeDot={false}
							connectNulls
						/>
					)}
					<Area
						type="linear"
						dataKey="revenue"
						stroke="#22c55e"
						strokeWidth={2}
						fill="url(#revenueGradient)"
						dot={false}
						activeDot={{
							r: 5,
							fill: '#22c55e',
							stroke: colors.cardBg,
							strokeWidth: 2,
						}}
					/>
				</AreaChart>
			</ResponsiveContainer>
			{hasPrev && (
				<div className="mt-2 flex items-center gap-4 text-[11px]">
					<span className="flex items-center gap-1.5">
						<span className="inline-block h-0.5 w-4 rounded bg-emerald-500" />
						<span className="text-muted-foreground">Current period</span>
					</span>
					<span className="flex items-center gap-1.5">
						<span
							className="inline-block h-0.5 w-4 rounded"
							style={{
								background: colors.mutedForeground,
								backgroundImage:
									'repeating-linear-gradient(90deg, transparent, transparent 3px, currentColor 3px, currentColor 5px)',
							}}
						/>
						<span className="text-muted-foreground">Previous period</span>
					</span>
				</div>
			)}
		</div>
	)
}
