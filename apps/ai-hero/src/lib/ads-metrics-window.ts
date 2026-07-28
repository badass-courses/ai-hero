export type FunnelMetricsRange = '24h' | 'today' | 'yesterday' | '7d' | '30d'

export function funnelMetricsWindow(range: FunnelMetricsRange, now: Date) {
	if (range === '24h') {
		return {
			range,
			timeZone: 'UTC',
			kind: 'rolling' as const,
			label: `rolling 24h ending ${now.toISOString()}`,
			start: new Date(now.getTime() - 24 * 60 * 60 * 1000),
			end: now,
		}
	}

	const start = new Date(now)
	start.setUTCHours(0, 0, 0, 0)
	if (range === 'yesterday') start.setUTCDate(start.getUTCDate() - 1)
	if (range === '7d') start.setUTCDate(start.getUTCDate() - 6)
	if (range === '30d') start.setUTCDate(start.getUTCDate() - 29)
	const end = range === 'yesterday' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) : now
	const startDate = start.toISOString().slice(0, 10)
	const endDate = new Date(Math.max(start.getTime(), end.getTime() - 1)).toISOString().slice(0, 10)

	return {
		range,
		timeZone: 'UTC',
		kind: 'calendar' as const,
		label: startDate === endDate ? `${startDate} (UTC)` : `${startDate} through ${endDate} (UTC)`,
		start,
		end,
	}
}
