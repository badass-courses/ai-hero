import { describe, expect, it } from 'vitest'

import {
	formatOfferDeadline,
	longZoneName,
	offerDeadlineFromEvidence,
	shortZoneName,
	type OfferDeadline,
} from './offer-deadline'

// Each expiry is drovr's Monday 23:59:59 in the pinned zone.
const known = (expiresAt: string, timeZone: string): OfferDeadline => ({
	expiresAt,
	timeZone,
	source: 'vercel-header',
})
const fallback = (expiresAt: string): OfferDeadline => ({
	expiresAt,
	timeZone: 'America/Los_Angeles',
	source: 'fallback',
})

describe('formatOfferDeadline, long (email body and offer page)', () => {
	it.each([
		[
			'US West',
			known('2026-10-06T06:59:59.000Z', 'America/Los_Angeles'),
			'Monday, October 5, 2026 at 11:59 PM Pacific Daylight Time',
		],
		[
			'US East',
			known('2026-10-06T03:59:59.000Z', 'America/New_York'),
			'Monday, October 5, 2026 at 11:59 PM Eastern Daylight Time',
		],
		[
			'Berlin',
			known('2026-10-05T21:59:59.000Z', 'Europe/Berlin'),
			'Monday, October 5, 2026 at 11:59 PM Central European Summer Time',
		],
		[
			'London',
			known('2026-10-05T22:59:59.000Z', 'Europe/London'),
			'Monday, October 5, 2026 at 11:59 PM British Summer Time',
		],
		[
			'Kolkata',
			known('2026-10-05T18:29:59.000Z', 'Asia/Kolkata'),
			'Monday, October 5, 2026 at 11:59 PM India Standard Time',
		],
		[
			'Sydney',
			known('2026-10-05T12:59:59.000Z', 'Australia/Sydney'),
			'Monday, October 5, 2026 at 11:59 PM Australian Eastern Daylight Time',
		],
	])('%s: the contact zone, absolute, long name', (_label, deadline, text) => {
		expect(formatOfferDeadline(deadline)).toBe(text)
	})

	it('fallback: Pacific plus the UTC callback', () => {
		expect(formatOfferDeadline(fallback('2026-10-06T06:59:59.000Z'))).toBe(
			"Monday, October 5, 2026 at 11:59 PM Pacific Daylight Time (that's Tuesday, October 6 at 6:59 AM UTC)",
		)
	})

	it('fallback keeps the pinned zone when drovr pinned another one', () => {
		// drovr may carry `fallback` on a previously pinned valid zone; the
		// expiry is 23:59:59 in that zone, so the text must name it.
		expect(
			formatOfferDeadline({
				expiresAt: '2026-10-05T21:59:59.000Z',
				timeZone: 'Europe/Berlin',
				source: 'fallback',
			}),
		).toBe(
			"Monday, October 5, 2026 at 11:59 PM Central European Summer Time (that's Monday, October 5 at 9:59 PM UTC)",
		)
	})

	describe('DST edges', () => {
		it('Berlin, the Monday after the EU change on 10-25: standard time', () => {
			expect(
				formatOfferDeadline(known('2026-10-26T22:59:59.000Z', 'Europe/Berlin')),
			).toBe(
				'Monday, October 26, 2026 at 11:59 PM Central European Standard Time',
			)
		})

		it('London, the Monday after 10-25: GMT', () => {
			expect(
				formatOfferDeadline(known('2026-10-26T23:59:59.000Z', 'Europe/London')),
			).toBe('Monday, October 26, 2026 at 11:59 PM Greenwich Mean Time')
		})

		it('US, the Monday before and after the 11-01 change', () => {
			expect(formatOfferDeadline(fallback('2026-10-27T06:59:59.000Z'))).toBe(
				"Monday, October 26, 2026 at 11:59 PM Pacific Daylight Time (that's Tuesday, October 27 at 6:59 AM UTC)",
			)
			expect(formatOfferDeadline(fallback('2026-11-03T07:59:59.000Z'))).toBe(
				"Monday, November 2, 2026 at 11:59 PM Pacific Standard Time (that's Tuesday, November 3 at 7:59 AM UTC)",
			)
			expect(
				formatOfferDeadline(known('2026-11-03T04:59:59.000Z', 'America/New_York')),
			).toBe('Monday, November 2, 2026 at 11:59 PM Eastern Standard Time')
		})

		it('Sydney, the Monday before and after its 10-04 start', () => {
			expect(
				formatOfferDeadline(known('2026-09-28T13:59:59.000Z', 'Australia/Sydney')),
			).toBe(
				'Monday, September 28, 2026 at 11:59 PM Australian Eastern Standard Time',
			)
			expect(
				formatOfferDeadline(known('2026-10-05T12:59:59.000Z', 'Australia/Sydney')),
			).toBe(
				'Monday, October 5, 2026 at 11:59 PM Australian Eastern Daylight Time',
			)
		})
	})

	it('never says midnight, tonight, tomorrow or "your time"', () => {
		const texts = [
			formatOfferDeadline(fallback('2026-10-06T06:59:59.000Z')),
			formatOfferDeadline(known('2026-10-05T12:59:59.000Z', 'Australia/Sydney')),
		]
		for (const text of texts) {
			expect(text).toContain('11:59 PM')
			expect(text).not.toMatch(/midnight|tonight|tomorrow|your time|12:00/i)
		}
	})

	it('drops the seconds of the :59:59 expiry', () => {
		expect(
			formatOfferDeadline(known('2026-10-05T21:59:59.000Z', 'Europe/Berlin')),
		).not.toMatch(/:59:59/)
	})

	it('rejects an unparseable instant', () => {
		expect(() =>
			formatOfferDeadline(known('not-a-date', 'Europe/Berlin')),
		).toThrow('invalid instant')
	})
})

describe('formatOfferDeadline, short (the email preview only)', () => {
	it.each([
		['America/Los_Angeles', '2026-10-06T06:59:59.000Z', 'Mon Oct 5, 11:59 PM PDT'],
		['America/New_York', '2026-10-06T03:59:59.000Z', 'Mon Oct 5, 11:59 PM EDT'],
		['Europe/Berlin', '2026-10-05T21:59:59.000Z', 'Mon Oct 5, 11:59 PM CEST'],
		['Europe/London', '2026-10-05T22:59:59.000Z', 'Mon Oct 5, 11:59 PM BST'],
		['Asia/Kolkata', '2026-10-05T18:29:59.000Z', 'Mon Oct 5, 11:59 PM IST'],
		['Australia/Sydney', '2026-10-05T12:59:59.000Z', 'Mon Oct 5, 11:59 PM AEDT'],
		['Europe/Berlin', '2026-10-26T22:59:59.000Z', 'Mon Oct 26, 11:59 PM CET'],
	])('%s %s', (timeZone, expiresAt, text) => {
		expect(formatOfferDeadline(known(expiresAt, timeZone), 'short')).toBe(text)
	})

	it('takes the short zone from our table, not Intl en-US (which prints GMT+2)', () => {
		const date = new Date('2026-10-05T21:59:59.000Z')
		const intlShort = new Intl.DateTimeFormat('en-US', {
			timeZone: 'Europe/Berlin',
			timeZoneName: 'short',
		})
			.formatToParts(date)
			.find((part) => part.type === 'timeZoneName')?.value
		expect(intlShort).toBe('GMT+2')
		expect(shortZoneName(date, 'Europe/Berlin')).toBe('CEST')
	})

	it('prints the UTC offset for a zone whose abbreviation is ambiguous', () => {
		const date = new Date('2026-10-05T15:59:59.000Z')
		expect(shortZoneName(date, 'Asia/Shanghai')).toBe('UTC+8')
		expect(shortZoneName(date, 'Asia/Kathmandu')).toBe('UTC+5:45')
	})
})

describe('zone names', () => {
	it('the long name is a word, never an offset, for the tested zones', () => {
		const date = new Date('2026-10-05T21:59:59.000Z')
		for (const zone of [
			'America/Los_Angeles',
			'America/New_York',
			'Europe/Berlin',
			'Europe/London',
			'Asia/Kolkata',
			'Australia/Sydney',
		]) {
			expect(longZoneName(date, zone)).not.toMatch(/GMT|UTC[+-]/)
		}
	})

	it('spells an unnamed zone as a UTC offset, not GMT', () => {
		// Intl en-US has no long name for Amman: it prints "GMT+03:00".
		expect(longZoneName(new Date('2026-10-05T20:59:59.000Z'), 'Asia/Amman')).toBe(
			'UTC+3',
		)
	})
})

describe('offerDeadlineFromEvidence', () => {
	it('a header zone is the contact zone; every other source is a fallback', () => {
		expect(
			offerDeadlineFromEvidence('2026-10-05T21:59:59.000Z', {
				type: 'BrowserEntryHeader',
				timeZone: 'Europe/Berlin' as never,
			}).source,
		).toBe('vercel-header')
		expect(
			offerDeadlineFromEvidence('2026-10-06T06:59:59.000Z', {
				type: 'ExplicitFallback',
				timeZone: 'America/Los_Angeles' as never,
			}).source,
		).toBe('fallback')
	})
})
