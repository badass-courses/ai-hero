import { z } from 'zod'

import { parseDrovrSignupDeliveryConfig } from '../subscriber-marketing/drovr-doi-signup'
import {
	DROVR_SIGNUPS_FROM,
	KIT_FROZEN_SOURCE,
	KIT_SIGNUPS_HISTORY,
	SIGNUP_RANGE_DAYS,
	summarizeSignups,
	type NewsletterSignups,
	type SignupDay,
	type SignupRange,
} from './newsletter-signups-series'

type Env = Record<string, string | undefined>
const TENANT = 'org-aihero'
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
// identifier fails the call closed, and so does kit-frozen, which names the
// frozen Kit days.
const SourceKey = z
	.string()
	.regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
	.refine((key) => key !== KIT_FROZEN_SOURCE)

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

export type {
	NewsletterSignups,
	SignupDay,
	SignupRange,
	SignupTotal,
} from './newsletter-signups-series'

const unavailable = (reason: string) => ({
	status: 'unavailable' as const,
	reason,
})

export type NewsletterSignupsRead =
	| {
			status: 'available'
			data: NewsletterSignups
			/** Why some days are unavailable: failed calls or a missing series. */
			gaps: string[]
	  }
	| ReturnType<typeof unavailable>

const DAY_MS = 24 * 60 * 60 * 1000
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`)
const daysBetween = (from: string, to: string) =>
	Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1

// The private AIH_KIT_SIGNUPS_HISTORY_JSON: Kit's daily new subscribers,
// one count per UTC day from..to, frozen at export. The window and seam are
// fixed here, so a wrong value can only blank the Kit days, never move them.
const KitSignupsHistory = z
	.object({
		v: z.literal(1),
		source: z.string().regex(/^kit-export-\d{8}$/),
		from: z.literal(KIT_SIGNUPS_HISTORY.from),
		to: z.literal(KIT_SIGNUPS_HISTORY.to),
		seam: z.literal(KIT_SIGNUPS_HISTORY.seam),
		days: z
			.array(Count)
			.length(daysBetween(KIT_SIGNUPS_HISTORY.from, KIT_SIGNUPS_HISTORY.to)),
	})
	.strict()
	.transform((history) => {
		const [, y, m, d] = history.source.match(/(\d{4})(\d{2})(\d{2})$/)!
		return { ...history, frozenOn: `${y}-${m}-${d}` }
	})
	.refine(
		({ frozenOn, to }) =>
			Number.isFinite(dayMs(frozenOn)) &&
			utcDay(dayMs(frozenOn)) === frozenOn &&
			frozenOn > to,
		'the export must be dated after its last day',
	)

/** The frozen Kit series, or null when the env var is missing or invalid. */
export function parseKitSignupsHistory(env: Env) {
	const raw = env.AIH_KIT_SIGNUPS_HISTORY_JSON?.trim()
	if (!raw) return null
	try {
		const parsed = KitSignupsHistory.safeParse(JSON.parse(raw))
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

/**
 * Daily new newsletter subscribers for a rolling window of UTC days. Days
 * through KIT_SIGNUPS_HISTORY.to come from the frozen Kit series in
 * AIH_KIT_SIGNUPS_HISTORY_JSON; later days from drovr's `GET /signup-counts`,
 * newest week first, asking only for the weeks the window needs. Counts and
 * source names only. A missing series and unconfigured, refused, timed out
 * or malformed calls are unavailable, never zero: their days stay
 * unavailable, and the read is unavailable when no day is known.
 */
export async function getNewsletterSignups(
	args: {
		range?: SignupRange
		env?: Env
		fetcher?: typeof fetch
		now?: number
	} = {},
): Promise<NewsletterSignupsRead> {
	const env = args.env ?? process.env
	const config = parseDrovrSignupDeliveryConfig(env)
	const history = parseKitSignupsHistory(env)
	const range = args.range ?? '30d'
	const now = args.now ?? Date.now()
	const fetcher = args.fetcher ?? fetch
	const to = utcDay(now)
	const from =
		range === 'all'
			? KIT_SIGNUPS_HISTORY.from
			: utcDay(now - (SIGNUP_RANGE_DAYS[range] - 1) * DAY_MS)

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

	// drovr is asked only for its own days, newest week first and one call at
	// a time, so today's week warms first and a cold load never asks for more
	// than a week at once. Kit already counted every day through the seam.
	const drovrFrom = from > DROVR_SIGNUPS_FROM ? from : DROVR_SIGNUPS_FROM
	const reported = new Map<string, z.infer<typeof SignupCountsDay>>()
	const gaps: string[] = []
	let asOf: string | null = null
	if (drovrFrom <= to && !config) gaps.push('drovr credentials are not configured')
	for (
		let newest = to;
		config && newest >= drovrFrom;
		newest = utcDay(dayMs(newest) - SIGNUP_CHUNK_DAYS * DAY_MS)
	) {
		const oldest = utcDay(dayMs(newest) - (SIGNUP_CHUNK_DAYS - 1) * DAY_MS)
		const read = await readChunk(oldest > drovrFrom ? oldest : drovrFrom, newest)
		if (read.status === 'unavailable') {
			gaps.push(read.reason)
			continue
		}
		for (const day of read.data.days) reported.set(day.day, day)
		if (asOf === null || Date.parse(read.data.asOf) < Date.parse(asOf))
			asOf = read.data.asOf
	}
	const kitDays = from <= KIT_SIGNUPS_HISTORY.to
	if (kitDays && !history)
		gaps.push('Kit signup history is missing or invalid')
	if (asOf === null && !(kitDays && history)) return unavailable(gaps[0]!)

	const days: SignupDay[] = Array.from(
		{ length: daysBetween(from, to) },
		(_, i): SignupDay => {
			const day = utcDay(dayMs(from) + i * DAY_MS)
			if (day <= KIT_SIGNUPS_HISTORY.to) {
				if (!history) return { day, source: 'kit-frozen', status: 'unavailable' }
				const total =
					history.days[daysBetween(KIT_SIGNUPS_HISTORY.from, day) - 1]!
				return {
					day,
					source: 'kit-frozen',
					status: 'complete',
					subscribed: { total, bySource: { [KIT_FROZEN_SOURCE]: total } },
					confirmed: null,
					unsubscribed: null,
				}
			}
			const row = reported.get(day)
			if (!row) return { day, source: 'drovr', status: 'unavailable' }
			return {
				day,
				source: 'drovr',
				status: row.complete ? 'complete' : 'partial',
				subscribed: row.subscribed,
				confirmed: row.confirmed ?? null,
				unsubscribed: row.unsubscribed ?? null,
			}
		},
	)
	return {
		status: 'available',
		gaps,
		data: summarizeSignups({
			range,
			from,
			to,
			asOf,
			history: {
				status: history ? 'available' : 'unavailable',
				...KIT_SIGNUPS_HISTORY,
				export: history?.source ?? null,
				frozenOn: history?.frozenOn ?? null,
			},
			days,
		}),
	}
}
