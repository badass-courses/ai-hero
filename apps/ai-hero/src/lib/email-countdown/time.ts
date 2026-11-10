/**
 * Time math for the email countdown GIF (`/api/email/countdown.gif`).
 *
 * Every email open fetches the image fresh, so all of this is computed from
 * the request's clock. Kept separate from the renderer so the boundaries
 * (a day, `until` itself, past `until`) are testable without decoding GIFs.
 */

/** How far ahead `until` may sit. Anything further is a typo or abuse. */
export const MAX_HORIZON_MS = 60 * 24 * 60 * 60 * 1000

/** One frame per second, so the GIF never claims more than a minute of motion. */
export const MAX_FRAMES = 60

const SECONDS_PER_DAY = 24 * 60 * 60

// A full ISO 8601 instant: date, time with seconds, and a zone. No bare dates
// and no zone-less local times, because those mean different moments in
// different runtimes.
const ISO_INSTANT =
	/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

export type ParsedUntil =
	| { ok: true; until: Date }
	| { ok: false; reason: string }

export function parseUntil(raw: string | null, now: Date): ParsedUntil {
	if (!raw) return { ok: false, reason: 'until is required' }
	const match = ISO_INSTANT.exec(raw)
	if (!match) {
		return {
			ok: false,
			reason: 'until must be an ISO instant, e.g. 2026-11-03T07:59:59Z',
		}
	}

	// `Date.parse` rolls 2026-02-31 over into March instead of failing.
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	const calendar = new Date(Date.UTC(year, month - 1, day))
	if (
		calendar.getUTCFullYear() !== year ||
		calendar.getUTCMonth() !== month - 1 ||
		calendar.getUTCDate() !== day
	) {
		return { ok: false, reason: 'until is not a real calendar date' }
	}

	const until = new Date(raw)
	if (Number.isNaN(until.getTime())) {
		return { ok: false, reason: 'until is not a valid instant' }
	}
	if (until.getTime() - now.getTime() > MAX_HORIZON_MS) {
		return { ok: false, reason: 'until must be within the next 60 days' }
	}
	// A past `until` is valid: an email opened after the deadline shows zeros.
	return { ok: true, until }
}

/** Whole seconds left, floored, never negative. */
export function secondsLeft(until: Date, now: Date): number {
	return Math.max(0, Math.floor((until.getTime() - now.getTime()) / 1000))
}

export type CountdownParts = {
	days: number
	hours: number
	minutes: number
	seconds: number
}

export function splitSeconds(total: number): CountdownParts {
	const clamped = Math.max(0, Math.floor(total))
	return {
		days: Math.floor(clamped / SECONDS_PER_DAY),
		hours: Math.floor((clamped % SECONDS_PER_DAY) / 3600),
		minutes: Math.floor((clamped % 3600) / 60),
		seconds: clamped % 60,
	}
}

/**
 * Seconds-left value for each frame, starting at `total` and counting down
 * one per frame. Stops at zero, so the last frame a non-looping GIF holds is
 * never below zero. At or past `until` it is a single zero frame.
 */
export function frameSeconds(total: number, maxFrames = MAX_FRAMES): number[] {
	const start = Math.max(0, Math.floor(total))
	const count = Math.min(maxFrames, start + 1)
	return Array.from({ length: count }, (_, index) => start - index)
}

/**
 * Whether the display shows a DAYS group. Decided once from the first frame,
 * so the layout never jumps mid-animation. Under a day it is HH:MM:SS; the
 * ended state shows all four groups as zeros.
 */
export function showsDays(total: number): boolean {
	return total <= 0 || total >= SECONDS_PER_DAY
}

export function pad2(value: number): string {
	return String(value).padStart(2, '0')
}
