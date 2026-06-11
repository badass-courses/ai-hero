'use client'

import {
	Bar,
	BarChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from 'recharts'

import { useChartColors } from '../../video-dashboard/_components/use-chart-colors'

interface CountryChartProps {
	data: { country: string; revenue: number; count: number }[]
}

function countryFlag(code: string | null): string {
	if (!code || code.length !== 2) return '🌍'
	const offset = 0x1f1e6
	const a = code.toUpperCase().charCodeAt(0) - 65 + offset
	const b = code.toUpperCase().charCodeAt(1) - 65 + offset
	return String.fromCodePoint(a, b)
}

function formatCurrency(value: number): string {
	if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`
	return `$${value.toFixed(0)}`
}

function CustomTooltip({
	active,
	payload,
}: {
	active?: boolean
	payload?: {
		value: number
		payload: { country: string; count: number; revenue: number }
	}[]
	label?: string
}) {
	if (!active || !payload?.length) return null
	const d = payload[0]?.payload
	if (!d) return null
	return (
		<div className="border-border/50 bg-card rounded-lg border px-3 py-2 shadow-xl">
			<p className="text-foreground text-sm font-medium">
				{countryFlag(d.country)} {d.country}
			</p>
			<p className="text-foreground text-lg font-bold tabular-nums">
				$
				{d.revenue.toLocaleString(undefined, {
					minimumFractionDigits: 0,
					maximumFractionDigits: 0,
				})}
			</p>
			<p className="text-muted-foreground text-xs">{d.count} purchases</p>
		</div>
	)
}

export function CountryChart({ data }: CountryChartProps) {
	const colors = useChartColors()
	const chartData = data.slice(0, 10).map((d) => ({
		...d,
		label: `${countryFlag(d.country)} ${d.country}`,
	}))

	return (
		<div className="h-[280px] w-full">
			<ResponsiveContainer width="100%" height="100%">
				<BarChart
					data={chartData}
					layout="vertical"
					margin={{ top: 4, right: 8, left: 4, bottom: 4 }}
				>
					<CartesianGrid
						strokeDasharray="3 3"
						stroke={colors.gridLine}
						horizontal={false}
					/>
					<XAxis
						type="number"
						tick={{ fill: colors.mutedForeground, fontSize: 11 }}
						axisLine={{ stroke: colors.gridLine }}
						tickLine={false}
						tickFormatter={formatCurrency}
					/>
					<YAxis
						type="category"
						dataKey="label"
						tick={{ fill: colors.mutedForeground, fontSize: 12 }}
						axisLine={false}
						tickLine={false}
						width={60}
					/>
					<Tooltip
						content={<CustomTooltip />}
						cursor={{ fill: colors.hoverBg }}
					/>
					<Bar
						dataKey="revenue"
						radius={[0, 4, 4, 0]}
						maxBarSize={24}
						fill="#22c55e"
						fillOpacity={0.7}
					/>
				</BarChart>
			</ResponsiveContainer>
		</div>
	)
}
