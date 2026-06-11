export function formatCompactCountdown(
	expires: Date | null | undefined,
	now: Date = new Date(),
): string | null {
	if (!expires) return null
	const ms = expires.getTime() - now.getTime()
	if (ms <= 0) return null

	const totalMinutes = Math.floor(ms / 60_000)
	const totalHours = Math.floor(totalMinutes / 60)
	const days = Math.floor(totalHours / 24)

	if (days >= 1) {
		const hours = totalHours % 24
		return `${days}d ${hours}h left`
	}
	if (totalHours >= 1) {
		const minutes = totalMinutes % 60
		return `${totalHours}h ${minutes}m left`
	}
	return `${totalMinutes}m left`
}

export function formatStartsAt(
	startsAt: Date,
	timezone: string,
	now: Date = new Date(),
): string {
	const yearOf = (d: Date) =>
		new Intl.DateTimeFormat('en-US', {
			year: 'numeric',
			timeZone: timezone,
		}).format(d)
	const sameYear = yearOf(startsAt) === yearOf(now)

	return new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: sameYear ? undefined : 'numeric',
		timeZone: timezone,
	}).format(startsAt)
}

export function formatPriceUSD(dollars: number): string {
	if (Number.isInteger(dollars)) return `$${dollars}`
	return `$${dollars.toFixed(2)}`
}
