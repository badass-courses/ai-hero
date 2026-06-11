'use client'

import { useMemo } from 'react'
import {
	Bar,
	BarChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from 'recharts'

import { useChartColors } from './use-chart-colors'

// ─── Country Codes → Flag Emoji ─────────────────────────────────────────────

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
	MX: 'Mexico',
	RU: 'Russia',
	KR: 'South Korea',
	PT: 'Portugal',
	CH: 'Switzerland',
}

// ─── Shared Tooltip ─────────────────────────────────────────────────────────

function BarTooltip({
	active,
	payload,
}: {
	active?: boolean
	payload?: { payload: { name: string; views: number } }[]
}) {
	if (!active || !payload?.length) return null
	const d = payload[0]?.payload
	if (!d) return null
	return (
		<div className="border-border/50 bg-card rounded-lg border px-3 py-2 shadow-xl">
			<p className="text-foreground text-sm font-medium">{d.name}</p>
			<p className="text-primary text-lg font-bold tabular-nums">
				{d.views.toLocaleString()} views
			</p>
		</div>
	)
}

// ─── Country Chart ───────────────────────────────────────────────────────────

export function CountryChart({
	data,
}: {
	data: { country: string; views: number; watchTimeMs: number }[]
}) {
	const colors = useChartColors()

	const chartData = useMemo(
		() =>
			data.map((d) => ({
				name: `${countryFlag(d.country)} ${COUNTRY_NAMES[d.country] || d.country}`,
				views: d.views,
				code: d.country,
			})),
		[data],
	)

	return (
		<div className="h-[360px] w-full">
			<ResponsiveContainer width="100%" height="100%">
				<BarChart
					data={chartData}
					layout="vertical"
					margin={{ top: 0, right: 8, left: 8, bottom: 0 }}
					barCategoryGap="20%"
				>
					<XAxis
						type="number"
						tick={{ fill: colors.mutedForeground, fontSize: 11 }}
						axisLine={false}
						tickLine={false}
						tickFormatter={(v: number) =>
							v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
						}
					/>
					<YAxis
						type="category"
						dataKey="name"
						tick={{ fill: colors.foreground, fontSize: 12 }}
						axisLine={false}
						tickLine={false}
						width={160}
					/>
					<Tooltip content={<BarTooltip />} cursor={{ fill: colors.hoverBg }} />
					<Bar
						dataKey="views"
						fill={colors.primary}
						radius={[0, 4, 4, 0]}
						fillOpacity={0.85}
					/>
				</BarChart>
			</ResponsiveContainer>
		</div>
	)
}
