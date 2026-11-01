import { vi } from 'vitest'

export const SIGNUP_ENV = {
	DROVR_API_BASE_URL: 'https://drovr.test/',
	DROVR_API_KEY_ORG_AIHERO: 'synthetic-key',
}
/** 2026-11-01 15:00 UTC: the window is 2026-10-03..2026-11-01. */
export const SIGNUP_NOW = Date.parse('2026-11-01T15:00:00.000Z')

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
		asOf: '2026-11-01T14:55:00.000Z',
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

// 2026-10-05..2026-10-25 and 2026-10-29 are absent: no directory receipts.
export const FAKE_SIGNUP_DAYS = [
	signupDay(
		'2026-10-03',
		{ 'ai-hero': 40, kit: 2 },
		{ confirmed: 30, unsubscribed: 1 },
	),
	signupDay(
		'2026-10-04',
		{ unattributed: 3 },
		{ confirmed: 1, unsubscribed: 0 },
	),
	signupDay(
		'2026-10-26',
		{ 'ai-hero': 100, unknown: 1 },
		{ confirmed: 80, unsubscribed: 3 },
	),
	signupDay(
		'2026-10-27',
		{ 'ai-hero': 90, unattributed: 0 },
		{ confirmed: 70, unsubscribed: 2 },
	),
	signupDay(
		'2026-10-28',
		{ 'ai-hero': 80, 'list-import': 500 },
		{ confirmed: 60, unsubscribed: 0 },
	),
	signupDay(
		'2026-10-30',
		{ 'ai-hero': 70, kit: 1 },
		{ confirmed: 50, unsubscribed: 4 },
	),
	signupDay('2026-10-31', { 'ai-hero': 60 }, { confirmed: 40, unsubscribed: 1 }),
	signupDay(
		'2026-11-01',
		{ 'ai-hero': 25 },
		{ complete: false, confirmed: 10, unsubscribed: 0 },
	),
]
