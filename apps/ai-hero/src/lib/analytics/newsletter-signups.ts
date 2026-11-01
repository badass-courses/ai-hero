import { z } from 'zod'

import { parseDrovrSignupDeliveryConfig } from '../subscriber-marketing/drovr-doi-signup'

type Env = Record<string, string | undefined>
const TENANT = 'org-aihero'
/** The panel and the agent read the same window: the last 30 UTC days. */
export const SIGNUP_WINDOW_DAYS = 30
/** drovr counts one UTC day at a time and caches completed days; a cold
 * 30-day read took about 6 s at concurrency 4 (prod probe, 2026-11-01).
 * Past this a slow drovr reads unavailable instead of holding
 * /admin/analytics. */
export const SIGNUP_COUNTS_TIMEOUT_MS = 10_000

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
// Payload source strings such as ai-hero, kit, list-import, unknown. Anything
// that could carry an address or identifier fails the whole read closed.
const SourceKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)

// drovr's GET /signup-counts. Days are oldest first; a day drovr can't vouch
// for is absent, never 0.
const SignupCountsDay = z
	.object({
		day: Day,
		complete: z.boolean(),
		subscribed: z.object({
			total: Count,
			bySource: z.record(SourceKey, Count),
		}),
		confirmed: Count.optional(),
		unsubscribed: Count.optional(),
	})
	.refine(
		({ subscribed }) =>
			Object.values(subscribed.bySource).reduce((a, b) => a + b, 0) ===
			subscribed.total,
		'subscribed.total must equal the sum of bySource',
	)
const SignupCounts = z.object({
	tenantId: z.literal(TENANT),
	from: Day,
	to: Day,
	asOf: z.string().datetime({ offset: true }),
	days: z.array(SignupCountsDay).max(90),
})

export type SignupDay =
	| { day: string; status: 'unavailable' }
	| {
			day: string
			/** partial: drovr does not vouch for the whole day yet, e.g. today. */
			status: 'complete' | 'partial'
			subscribed: { total: number; bySource: Record<string, number> }
			/** null when drovr did not report it for this day. */
			confirmed: number | null
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

export type NewsletterSignups = {
	provider: 'drovr'
	asOf: string
	from: string
	to: string
	/** Oldest first, one row per UTC day in [from, to]. */
	days: SignupDay[]
	/** Sources with any signups in the window, largest first. */
	sources: string[]
	totals: { last7: SignupTotal; last30: SignupTotal }
}

const unavailable = (reason: string) => ({
	status: 'unavailable' as const,
	reason,
})

export type NewsletterSignupsRead =
	| { status: 'available'; data: NewsletterSignups }
	| ReturnType<typeof unavailable>

const DAY_MS = 24 * 60 * 60 * 1000
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function total(days: SignupDay[]): SignupTotal {
	const reported = days.filter((day) => day.status !== 'unavailable')
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

/**
 * Daily new newsletter subscribers by source for the last 30 UTC days, from
 * drovr's `GET /signup-counts`. Counts and source names only. Unconfigured,
 * refused, timed out or malformed reads are unavailable, never zero, and a
 * day drovr leaves out stays unavailable in the result.
 */
export async function getNewsletterSignups(
	args: { env?: Env; fetcher?: typeof fetch; now?: number } = {},
): Promise<NewsletterSignupsRead> {
	const config = parseDrovrSignupDeliveryConfig(args.env ?? process.env)
	if (!config) return unavailable('drovr credentials are not configured')

	const now = args.now ?? Date.now()
	const to = utcDay(now)
	const from = utcDay(now - (SIGNUP_WINDOW_DAYS - 1) * DAY_MS)
	const fetcher = args.fetcher ?? fetch
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), SIGNUP_COUNTS_TIMEOUT_MS)
	let body: z.infer<typeof SignupCounts>
	try {
		const response = await fetcher(
			`${config.baseUrl}/signup-counts?from=${from}&to=${to}`,
			{
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${config.apiKey}`,
				},
				cache: 'no-store',
				signal: controller.signal,
			},
		)
		if (!response.ok)
			return unavailable(`drovr signup-counts read failed (${response.status})`)
		const parsed = SignupCounts.safeParse(await response.json())
		if (!parsed.success)
			return unavailable('drovr signup-counts response is invalid')
		body = parsed.data
	} catch {
		return unavailable(
			controller.signal.aborted
				? 'drovr signup-counts read timed out'
				: 'drovr signup-counts read failed',
		)
	} finally {
		clearTimeout(timer)
	}

	const reported = new Map(body.days.map((day) => [day.day, day]))
	if (
		body.from !== from ||
		body.to !== to ||
		reported.size !== body.days.length ||
		body.days.some((day) => day.day < from || day.day > to)
	)
		return unavailable('drovr signup-counts answered a different window')

	const days: SignupDay[] = Array.from(
		{ length: SIGNUP_WINDOW_DAYS },
		(_, i) => {
			const day = utcDay(Date.parse(`${from}T00:00:00Z`) + i * DAY_MS)
			const row = reported.get(day)
			if (!row) return { day, status: 'unavailable' }
			return {
				day,
				status: row.complete ? 'complete' : 'partial',
				subscribed: row.subscribed,
				confirmed: row.confirmed ?? null,
				unsubscribed: row.unsubscribed ?? null,
			}
		},
	)
	const last30 = total(days)
	const sources = Object.entries(last30.subscribed.bySource)
		.filter(([, n]) => n > 0)
		.sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
		.map(([source]) => source)
	return {
		status: 'available',
		data: {
			provider: 'drovr',
			asOf: body.asOf,
			from,
			to,
			days,
			sources,
			totals: { last7: total(days.slice(-7)), last30 },
		},
	}
}
