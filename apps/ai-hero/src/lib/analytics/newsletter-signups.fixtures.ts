import { vi } from 'vitest'

export const SIGNUP_ENV = {
	DROVR_API_BASE_URL: 'https://drovr.test/',
	DROVR_API_KEY_ORG_AIHERO: 'synthetic-key',
}
/** 2026-12-20 15:00 UTC: the window is 2026-11-21..2026-12-20. */
export const SIGNUP_NOW = Date.parse('2026-12-20T15:00:00.000Z')

export function signupDay(
	date: string,
	bySource: Record<string, number>,
	extra: { complete?: boolean; confirmed?: number; unsubscribed?: number } = {},
) {
	return {
		day: date,
		complete: extra.complete ?? true,
		subscribed: {
			total: Object.values(bySource).reduce((a, b) => a + b, 0),
			bySource,
		},
		...(extra.confirmed === undefined ? {} : { confirmed: extra.confirmed }),
		...(extra.unsubscribed === undefined
			? {}
			: { unsubscribed: extra.unsubscribed }),
	}
}

type FakeDay = ReturnType<typeof signupDay>

/** drovr's documented shape: oldest first, absent days left out. */
export function signupCountsBody(from: string, to: string, days: FakeDay[]) {
	return {
		tenantId: 'org-aihero',
		from,
		to,
		asOf: '2026-12-20T14:55:00.000Z',
		days: days.filter((day) => day.day >= from && day.day <= to),
	}
}

/**
 * A fake drovr `GET /signup-counts`: answers each call with the given days
 * inside its from..to. `override` replaces the answer for one window.
 */
export function fakeDrovr(
	days: FakeDay[],
	override: (from: string, to: string) => Response | undefined = () =>
		undefined,
) {
	return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
		const params = new URL(String(url)).searchParams
		const from = params.get('from')!
		const to = params.get('to')!
		return override(from, to) ?? json(signupCountsBody(from, to, days))
	})
}

export const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})

// 2026-11-23..2026-12-13 and 2026-12-17 are absent: no directory receipts.
export const FAKE_SIGNUP_DAYS = [
	signupDay(
		'2026-11-21',
		{ 'ai-hero': 40, kit: 2 },
		{ confirmed: 30, unsubscribed: 1 },
	),
	signupDay(
		'2026-11-22',
		{ unattributed: 3 },
		{ confirmed: 1, unsubscribed: 0 },
	),
	signupDay(
		'2026-12-14',
		{ 'ai-hero': 100, unknown: 1 },
		{ confirmed: 80, unsubscribed: 3 },
	),
	signupDay(
		'2026-12-15',
		{ 'ai-hero': 90, unattributed: 0 },
		{ confirmed: 70, unsubscribed: 2 },
	),
	signupDay(
		'2026-12-16',
		{ 'ai-hero': 80, 'list-import': 500 },
		{ confirmed: 60, unsubscribed: 0 },
	),
	signupDay(
		'2026-12-18',
		{ 'ai-hero': 70, kit: 1 },
		{ confirmed: 50, unsubscribed: 4 },
	),
	signupDay('2026-12-19', { 'ai-hero': 60 }, { confirmed: 40, unsubscribed: 1 }),
	signupDay(
		'2026-12-20',
		{ 'ai-hero': 25 },
		{ complete: false, confirmed: 10, unsubscribed: 0 },
	),
]

/** 2026-11-01 15:00 UTC: two days past the Kit-to-drovr seam. */
export const SEAM_NOW = Date.parse('2026-11-01T15:00:00.000Z')

/**
 * A synthetic AIH_KIT_SIGNUPS_HISTORY_JSON, never real counts: each Kit day
 * reads its day of the month, so a shifted index shows up as a wrong sum.
 */
export function kitHistory(overrides: Record<string, unknown> = {}) {
	const days: number[] = []
	for (
		let at = Date.parse('2025-08-17T00:00:00Z');
		at <= Date.parse('2026-10-29T00:00:00Z');
		at += 24 * 60 * 60 * 1000
	)
		days.push(new Date(at).getUTCDate())
	return JSON.stringify({
		v: 1,
		source: 'kit-export-20261101',
		from: '2025-08-17',
		to: '2026-10-29',
		seam: '2026-10-29T20:00:00Z',
		days,
		...overrides,
	})
}

export const HISTORY_ENV = {
	...SIGNUP_ENV,
	AIH_KIT_SIGNUPS_HISTORY_JSON: kitHistory(),
}

// drovr around the seam. Its 10-28 and 10-29 rows must never be read: Kit
// already counted those people.
export const SEAM_DROVR_DAYS = [
	signupDay('2026-10-28', { 'ai-hero': 400 }),
	signupDay('2026-10-29', { 'ai-hero': 500 }),
	signupDay('2026-10-30', { 'ai-hero': 30 }, { confirmed: 20, unsubscribed: 1 }),
	signupDay('2026-10-31', { 'ai-hero': 31 }, { confirmed: 21, unsubscribed: 0 }),
	signupDay(
		'2026-11-01',
		{ 'ai-hero': 11 },
		{ complete: false, confirmed: 5, unsubscribed: 0 },
	),
]
