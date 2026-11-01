import { z } from 'zod'

import { parseDrovrSignupDeliveryConfig } from '../subscriber-marketing/drovr-doi-signup'

type Env = Record<string, string | undefined>
const TENANT = 'org-aihero'
/** The two windows the panel and the agent read, in UTC days. */
export type SignupWindowDays = 7 | 30
/** drovr counts one UTC day at a time and caches completed days. Cold, 7
 * days take about 5 s and 31 days about 23 s (Census, 2026-11-01), so the
 * read asks for at most a week per call. */
export const SIGNUP_CHUNK_DAYS = 7
/** Owned limit per drovr call: about twice a cold 7-day read. Past it the
 * chunk's days read unavailable instead of holding /admin/analytics. */
export const SIGNUP_COUNTS_TIMEOUT_MS = 10_000

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
// Payload source strings such as ai-hero, kit, list-import and the reserved
// unknown and unattributed. Anything that could carry an address or
// identifier fails the call closed.
const SourceKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)

// drovr's GET /signup-counts. Days are oldest first; a day with no directory
// receipts is absent, never 0. complete: asOf is 15+ minutes past day end.
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
	days: z.array(SignupCountsDay).max(31),
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

export type NewsletterSignups = {
	provider: 'drovr'
	/** The oldest asOf among the drovr calls behind this read. */
	asOf: string
	from: string
	to: string
	windowDays: SignupWindowDays
	/** Oldest first, one row per UTC day in [from, to]. */
	days: SignupDay[]
	/** Sources with any signups in the window, largest first. */
	sources: string[]
	totals: { last7: SignupTotal; last30: SignupTotal | null }
}

const unavailable = (reason: string) => ({
	status: 'unavailable' as const,
	reason,
})

export type NewsletterSignupsRead =
	| {
			status: 'available'
			data: NewsletterSignups
			/** Why some calls failed; their days read unavailable. */
			gaps: string[]
	  }
	| ReturnType<typeof unavailable>

const DAY_MS = 24 * 60 * 60 * 1000
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

type ReportedDay = Exclude<SignupDay, { status: 'unavailable' }>
const isReported = (day: SignupDay): day is ReportedDay =>
	day.status !== 'unavailable'

function total(days: SignupDay[]): SignupTotal {
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

/**
 * Daily new newsletter subscribers by source for the last 7 or 30 UTC days,
 * from drovr's `GET /signup-counts`, newest week first. Counts and source
 * names only. Unconfigured, refused, timed out or malformed calls are
 * unavailable, never zero: their days stay unavailable, and the read is
 * unavailable when no call succeeds.
 */
export async function getNewsletterSignups(
	args: {
		days?: SignupWindowDays
		env?: Env
		fetcher?: typeof fetch
		now?: number
	} = {},
): Promise<NewsletterSignupsRead> {
	const config = parseDrovrSignupDeliveryConfig(args.env ?? process.env)
	if (!config) return unavailable('drovr credentials are not configured')

	const windowDays = args.days ?? 30
	const now = args.now ?? Date.now()
	const fetcher = args.fetcher ?? fetch

	async function readChunk(from: string, to: string) {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), SIGNUP_COUNTS_TIMEOUT_MS)
		try {
			const response = await fetcher(
				`${config!.baseUrl}/signup-counts?from=${from}&to=${to}`,
				{
					headers: {
						accept: 'application/json',
						authorization: `Bearer ${config!.apiKey}`,
					},
					cache: 'no-store',
					signal: controller.signal,
				},
			)
			if (!response.ok)
				return unavailable(
					`drovr signup-counts read failed (${response.status})`,
				)
			const parsed = SignupCounts.safeParse(await response.json())
			if (!parsed.success)
				return unavailable('drovr signup-counts response is invalid')
			const body = parsed.data
			if (
				body.from !== from ||
				body.to !== to ||
				new Set(body.days.map((day) => day.day)).size !== body.days.length ||
				body.days.some((day) => day.day < from || day.day > to)
			)
				return unavailable('drovr signup-counts answered a different window')
			return { status: 'available' as const, data: body }
		} catch {
			return unavailable(
				controller.signal.aborted
					? 'drovr signup-counts read timed out'
					: 'drovr signup-counts read failed',
			)
		} finally {
			clearTimeout(timer)
		}
	}

	// Newest week first and one call at a time, so today's week warms first
	// and a cold load never asks drovr for more than a week at once.
	const reported = new Map<string, z.infer<typeof SignupCountsDay>>()
	const gaps: string[] = []
	let asOf: string | null = null
	for (let back = 0; back < windowDays; back += SIGNUP_CHUNK_DAYS) {
		const oldest = Math.min(back + SIGNUP_CHUNK_DAYS, windowDays) - 1
		const read = await readChunk(
			utcDay(now - oldest * DAY_MS),
			utcDay(now - back * DAY_MS),
		)
		if (read.status === 'unavailable') {
			gaps.push(read.reason)
			continue
		}
		for (const day of read.data.days) reported.set(day.day, day)
		if (asOf === null || Date.parse(read.data.asOf) < Date.parse(asOf))
			asOf = read.data.asOf
	}
	if (asOf === null) return unavailable(gaps[0]!)

	const from = utcDay(now - (windowDays - 1) * DAY_MS)
	const days: SignupDay[] = Array.from({ length: windowDays }, (_, i) => {
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
	})
	const all = total(days)
	const sources = Object.entries(all.subscribed.bySource)
		.filter(([, n]) => n > 0)
		.sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
		.map(([source]) => source)
	return {
		status: 'available',
		gaps,
		data: {
			provider: 'drovr',
			asOf,
			from,
			to: utcDay(now),
			windowDays,
			days,
			sources,
			totals: {
				last7: windowDays === 7 ? all : total(days.slice(-7)),
				last30: windowDays === 30 ? all : null,
			},
		},
	}
}
