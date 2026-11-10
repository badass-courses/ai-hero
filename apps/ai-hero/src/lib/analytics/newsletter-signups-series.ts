/**
 * The newsletter signups series: a frozen Kit export through
 * KIT_SIGNUPS_HISTORY.to, drovr's signup_counts from the day after. Pure and
 * client-safe, so the panel can merge its reads day by day and add them up
 * the same way the server does.
 */

/** Rolling windows in UTC days, ending today. all starts at the Kit export. */
export const SIGNUP_RANGES = ['7d', '30d', '90d', '365d', 'all'] as const
export type SignupRange = (typeof SIGNUP_RANGES)[number]
export const SIGNUP_RANGE_DAYS: Record<
	Exclude<SignupRange, 'all'>,
	number
> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }

/**
 * Before the seam Kit took most signups, so drovr's days through `to` read
 * low. Those days come from the frozen Kit export; every day after `to` is
 * drovr's, and a drovr row on or before `to` is never read.
 */
export const KIT_SIGNUPS_HISTORY = {
	from: '2025-08-17',
	to: '2026-10-29',
	seam: '2026-10-29T20:00:00Z',
} as const
export const DROVR_SIGNUPS_FROM = '2026-10-30'
/** The bySource key for a Kit day: the export has no source split. */
export const KIT_FROZEN_SOURCE = 'kit-frozen'

export type SignupDaySource = 'kit-frozen' | 'drovr'
export type SignupDay =
	| { day: string; source: SignupDaySource; status: 'unavailable' }
	| {
			day: string
			source: SignupDaySource
			/** partial: drovr does not vouch for the whole day yet, e.g. today. */
			status: 'complete' | 'partial'
			subscribed: { total: number; bySource: Record<string, number> }
			/** null when the day's source did not report it. Kit days never do. */
			confirmed: number | null
			/** Every contact that moved to unsubscribed, any source. */
			unsubscribed: number | null
	  }

export type SignupTotal = {
	days: number
	reportedDays: number
	partialDays: number
	/** Every day in the span is reported and complete. */
	complete: boolean
	subscribed: { total: number; bySource: Record<string, number> }
	/** null unless every reported day carries the count. */
	confirmed: number | null
	unsubscribed: number | null
}

export type SignupHistory = {
	status: 'available' | 'unavailable'
	from: string
	to: string
	seam: string
	/** The export's label, e.g. kit-export-20261101; null when unavailable. */
	export: string | null
	/** The UTC day the export was taken; null when unavailable. */
	frozenOn: string | null
}

export type NewsletterSignups = {
	range: SignupRange
	from: string
	to: string
	windowDays: number
	/** The oldest asOf among the drovr calls behind this read; null if none answered. */
	asOf: string | null
	history: SignupHistory
	/** Oldest first, one row per UTC day in [from, to]. */
	days: SignupDay[]
	/** UTC months touching the window, oldest first. The first may be partial. */
	months: Array<{ month: string; total: SignupTotal }>
	/** Sources with any signups in the window, largest first. */
	sources: string[]
	totals: { window: SignupTotal; last7: SignupTotal; last30: SignupTotal | null }
}

type ReportedDay = Exclude<SignupDay, { status: 'unavailable' }>
const isReported = (day: SignupDay): day is ReportedDay =>
	day.status !== 'unavailable'

export function signupTotal(days: SignupDay[]): SignupTotal {
	const reported = days.filter(isReported)
	const bySource: Record<string, number> = {}
	let subscribed = 0
	for (const day of reported) {
		subscribed += day.subscribed.total
		for (const [source, n] of Object.entries(day.subscribed.bySource))
			bySource[source] = (bySource[source] ?? 0) + n
	}
	const sum = (key: 'confirmed' | 'unsubscribed') =>
		reported.every((day) => day[key] !== null)
			? reported.reduce((a, day) => a + day[key]!, 0)
			: null
	const partialDays = reported.filter((day) => day.status === 'partial').length
	return {
		days: days.length,
		reportedDays: reported.length,
		partialDays,
		complete: reported.length === days.length && partialDays === 0,
		subscribed: { total: subscribed, bySource },
		confirmed: sum('confirmed'),
		unsubscribed: sum('unsubscribed'),
	}
}

/** Sums, sources and months from the days, so they always agree. */
export function summarizeSignups(
	read: Pick<
		NewsletterSignups,
		'range' | 'from' | 'to' | 'asOf' | 'history' | 'days'
	>,
): NewsletterSignups {
	const { days } = read
	const window = signupTotal(days)
	const byMonth = new Map<string, SignupDay[]>()
	for (const day of days) {
		const month = day.day.slice(0, 7)
		byMonth.set(month, [...(byMonth.get(month) ?? []), day])
	}
	return {
		...read,
		windowDays: days.length,
		months: [...byMonth].map(([month, inMonth]) => ({
			month,
			total: signupTotal(inMonth),
		})),
		sources: Object.entries(window.subscribed.bySource)
			.filter(([, n]) => n > 0)
			.sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
			.map(([source]) => source),
		totals: {
			window,
			last7: signupTotal(days.slice(-7)),
			last30: days.length >= 30 ? signupTotal(days.slice(-30)) : null,
		},
	}
}

/**
 * The widest read, with each of its unavailable days filled from a narrower
 * read that has it, e.g. when the 30-day read's newest week failed but the
 * 7-day read answered. Only drovr days fill: Kit days come from the same
 * frozen series in every read.
 */
export function mergeSignupReads(
	widest: NewsletterSignups,
	...narrower: Array<NewsletterSignups | undefined>
): NewsletterSignups {
	const fills = new Map<string, { day: ReportedDay; asOf: string | null }>()
	for (const read of narrower)
		for (const day of read?.days ?? [])
			if (day.source === 'drovr' && isReported(day) && !fills.has(day.day))
				fills.set(day.day, { day, asOf: read!.asOf })
	const asOfs = [widest.asOf]
	const days = widest.days.map((day) => {
		const fill = fills.get(day.day)
		if (isReported(day) || day.source !== 'drovr' || !fill) return day
		asOfs.push(fill.asOf)
		return fill.day
	})
	const asOf =
		asOfs
			.filter((at): at is string => at !== null)
			.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null
	return summarizeSignups({ ...widest, asOf, days })
}
