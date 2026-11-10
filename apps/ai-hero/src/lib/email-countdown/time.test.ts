import { describe, expect, it } from 'vitest'
import {
	frameSeconds,
	MAX_FRAMES,
	parseUntil,
	secondsLeft,
	showsDays,
	splitSeconds,
} from './time'

const now = new Date('2026-11-02T15:30:00.000Z')

describe('parseUntil', () => {
	it('accepts a UTC instant within 60 days', () => {
		const parsed = parseUntil('2026-11-03T07:59:59Z', now)
		expect(parsed).toEqual({
			ok: true,
			until: new Date('2026-11-03T07:59:59Z'),
		})
	})

	it('accepts milliseconds and a zone offset', () => {
		const parsed = parseUntil('2026-11-02T23:59:59.500-08:00', now)
		expect(parsed.ok && parsed.until.toISOString()).toBe(
			'2026-11-03T07:59:59.500Z',
		)
	})

	it('accepts a past instant, which renders the ended state', () => {
		expect(parseUntil('2026-10-01T00:00:00Z', now).ok).toBe(true)
	})

	it('accepts exactly 60 days ahead and rejects one second more', () => {
		expect(parseUntil('2027-01-01T15:30:00Z', now).ok).toBe(true)
		expect(parseUntil('2027-01-01T15:30:01Z', now)).toMatchObject({
			ok: false,
		})
	})

	it.each([
		['missing', null],
		['empty', ''],
		['a bare date', '2026-11-03'],
		['no zone', '2026-11-03T07:59:59'],
		['no seconds', '2026-11-03T07:59Z'],
		['a non-date', 'tomorrow'],
		['epoch millis', '1793692799000'],
		['hour 24', '2026-11-03T24:00:00Z'],
		['minute 60', '2026-11-03T07:60:00Z'],
		['month 13', '2026-13-01T00:00:00Z'],
		['31 November', '2026-11-31T00:00:00Z'],
		['29 February in a common year', '2027-02-29T00:00:00Z'],
		['trailing text', '2026-11-03T07:59:59Z<script>'],
		['leading space', ' 2026-11-03T07:59:59Z'],
	])('rejects %s', (_label, raw) => {
		expect(parseUntil(raw, now).ok).toBe(false)
	})
})

describe('secondsLeft', () => {
	const until = new Date('2026-11-03T07:59:59Z')

	it('floors partial seconds', () => {
		expect(secondsLeft(until, new Date('2026-11-03T07:59:57.001Z'))).toBe(1)
		expect(secondsLeft(until, new Date('2026-11-03T07:59:58.999Z'))).toBe(0)
	})

	it('is zero at until and stays zero after it', () => {
		expect(secondsLeft(until, until)).toBe(0)
		expect(secondsLeft(until, new Date('2026-12-01T00:00:00Z'))).toBe(0)
	})
})

describe('splitSeconds', () => {
	it('splits days, hours, minutes and seconds', () => {
		const total = 2 * 86400 + 3 * 3600 + 4 * 60 + 5
		expect(splitSeconds(total)).toEqual({
			days: 2,
			hours: 3,
			minutes: 4,
			seconds: 5,
		})
	})

	it('rolls over at each unit', () => {
		expect(splitSeconds(59)).toEqual({
			days: 0,
			hours: 0,
			minutes: 0,
			seconds: 59,
		})
		expect(splitSeconds(60)).toEqual({
			days: 0,
			hours: 0,
			minutes: 1,
			seconds: 0,
		})
		expect(splitSeconds(86399)).toEqual({
			days: 0,
			hours: 23,
			minutes: 59,
			seconds: 59,
		})
		expect(splitSeconds(86400)).toEqual({
			days: 1,
			hours: 0,
			minutes: 0,
			seconds: 0,
		})
	})

	it('clamps negatives to zero', () => {
		expect(splitSeconds(-5)).toEqual({
			days: 0,
			hours: 0,
			minutes: 0,
			seconds: 0,
		})
	})
})

describe('frameSeconds', () => {
	it('counts down one second per frame for a minute', () => {
		const frames = frameSeconds(1000)
		expect(frames).toHaveLength(MAX_FRAMES)
		expect(frames[0]).toBe(1000)
		expect(frames.at(-1)).toBe(941)
	})

	it('stops at zero near until', () => {
		expect(frameSeconds(3)).toEqual([3, 2, 1, 0])
	})

	it('is a single zero frame at or past until', () => {
		expect(frameSeconds(0)).toEqual([0])
		expect(frameSeconds(-10)).toEqual([0])
	})
})

describe('showsDays', () => {
	it('drops the days group under a day and shows it when ended', () => {
		expect(showsDays(86400)).toBe(true)
		expect(showsDays(86399)).toBe(false)
		expect(showsDays(1)).toBe(false)
		expect(showsDays(0)).toBe(true)
	})
})
