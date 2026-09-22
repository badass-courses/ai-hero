'use client'

type TrafficBreakdownRow = {
	sessions: number
	users: number
	sessionPercent: number
	trafficSessionPercent: number
}

export type TrafficOverviewWithBreakdowns = {
	sessions: number
	totalUsers: number
	newUsers: number
	pageviews: number
	deviceCategories?: Array<TrafficBreakdownRow & { deviceCategory: string }>
	operatingSystems?: Array<TrafficBreakdownRow & { operatingSystem: string }>
	screenResolutions?: Array<TrafficBreakdownRow & { screenResolution: string }>
}

function formatPercent(value: number) {
	return `${value.toFixed(1)}%`
}

function TrafficBreakdownTable<T extends TrafficBreakdownRow>({
	title,
	label,
	rows,
	getName,
}: {
	title: string
	label: string
	rows: T[]
	getName: (row: T) => string
}) {
	if (!rows.length) return null

	return (
		<section className="min-w-0">
			<div className="mb-2 flex items-baseline justify-between gap-2">
				<h3 className="text-sm font-semibold">{title}</h3>
				<span className="text-muted-foreground text-[11px]">
					Top {rows.length}
				</span>
			</div>
			<div className="overflow-x-auto rounded-xl border border-border/50">
				<table className="w-full min-w-[440px] text-left text-sm">
					<thead className="bg-muted/30 text-muted-foreground text-[11px] uppercase tracking-wide">
						<tr>
							<th className="px-3 py-2 font-medium">{label}</th>
							<th className="px-3 py-2 text-right font-medium">Sessions</th>
							<th className="px-3 py-2 text-right font-medium">Users</th>
							<th className="px-3 py-2 text-right font-medium">In rows</th>
							<th className="px-3 py-2 text-right font-medium">Of traffic</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr
								key={getName(row)}
								className="border-t border-border/40 tabular-nums"
							>
								<td className="max-w-[220px] truncate px-3 py-2 font-medium">
									{getName(row)}
								</td>
								<td className="px-3 py-2 text-right">
									{row.sessions.toLocaleString()}
								</td>
								<td className="px-3 py-2 text-right">
									{row.users.toLocaleString()}
								</td>
								<td className="px-3 py-2 text-right">
									{formatPercent(row.sessionPercent)}
								</td>
								<td className="px-3 py-2 text-right">
									{formatPercent(row.trafficSessionPercent)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	)
}

export function TrafficBreakdownPanel({
	traffic,
}: {
	traffic: TrafficOverviewWithBreakdowns | null
}) {
	if (!traffic) return null

	const deviceCategories = traffic.deviceCategories ?? []
	const operatingSystems = traffic.operatingSystems ?? []
	const screenResolutions = traffic.screenResolutions ?? []

	if (
		deviceCategories.length === 0 &&
		operatingSystems.length === 0 &&
		screenResolutions.length === 0
	) {
		return null
	}

	return (
		<section className="rounded-2xl border border-border/50 p-4 sm:p-5">
			<div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
				<div>
					<h2 className="text-base font-semibold">180 day traffic details</h2>
					<p className="text-muted-foreground text-xs">
						GA4 traffic-only view. In rows is share inside the table. Of traffic is
						share of all {traffic.sessions.toLocaleString()} sessions.
					</p>
				</div>
				<div className="text-muted-foreground text-xs tabular-nums">
					{traffic.totalUsers.toLocaleString()} users ·{' '}
					{traffic.pageviews.toLocaleString()} pageviews
				</div>
			</div>
			<div className="grid gap-4 xl:grid-cols-3">
				<TrafficBreakdownTable
					title="Device category"
					label="Device"
					rows={deviceCategories}
					getName={(row) => row.deviceCategory}
				/>
				<TrafficBreakdownTable
					title="Operating systems"
					label="OS"
					rows={operatingSystems.slice(0, 10)}
					getName={(row) => row.operatingSystem}
				/>
				<TrafficBreakdownTable
					title="Screen resolutions"
					label="Resolution"
					rows={screenResolutions.slice(0, 10)}
					getName={(row) => row.screenResolution}
				/>
			</div>
		</section>
	)
}
