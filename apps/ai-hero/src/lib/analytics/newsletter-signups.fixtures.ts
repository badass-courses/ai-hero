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

/** drovr's documented shape: oldest first, absent days left out. */
export function signupCountsBody(days: ReturnType<typeof signupDay>[]) {
	return {
		tenantId: 'org-aihero',
		from: '2026-10-03',
		to: '2026-11-01',
		asOf: '2026-11-01T14:55:00.000Z',
		days,
	}
}

// 2026-10-04..2026-10-25 and 2026-10-29 are absent: drovr can't vouch for them.
export const FAKE_SIGNUP_DAYS = [
	signupDay(
		'2026-10-03',
		{ 'ai-hero': 40, kit: 2 },
		{ confirmed: 30, unsubscribed: 1 },
	),
	signupDay(
		'2026-10-26',
		{ 'ai-hero': 100, unknown: 1 },
		{ confirmed: 80, unsubscribed: 3 },
	),
	signupDay('2026-10-27', { 'ai-hero': 90 }, { confirmed: 70, unsubscribed: 2 }),
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

export const respondWith = (body: unknown, status = 200) =>
	vi.fn().mockResolvedValue(
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		}),
	)
