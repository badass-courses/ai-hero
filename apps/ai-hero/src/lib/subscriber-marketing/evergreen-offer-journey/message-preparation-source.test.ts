import { describe, expect, it } from 'vitest'

import { pilotDeadlineDisplay } from './message-preparation-source'

const issued = (
	type: 'BrowserEntryHeader' | 'ExplicitFallback',
	timeZone: string,
	expiresAt: string,
) =>
	({
		expiresAt,
		deadlineTimeZone: { type, timeZone },
	}) as unknown as Parameters<typeof pilotDeadlineDisplay>[0]

const berlin = issued('BrowserEntryHeader', 'Europe/Berlin', '2026-10-05T21:59:59.000Z')
const pacific = issued(
	'ExplicitFallback',
	'America/Los_Angeles',
	'2026-10-06T06:59:59.000Z',
)

describe('pilotDeadlineDisplay (the pilot DEADLINE_DISPLAY)', () => {
	it('switch unset: the text the pilot has always printed', () => {
		expect(pilotDeadlineDisplay(berlin, {})).toBe(
			'Monday, October 5, 2026 at 11:59:59 PM Central European Summer Time',
		)
		expect(
			pilotDeadlineDisplay(pacific, {
				AIH_EVERGREEN_DEADLINE_FORMAT_V2_ENABLED: 'TRUE',
			}),
		).toBe('Monday, October 5, 2026 at 11:59:59 PM Pacific Daylight Time')
	})

	it('switch true: the one offer-deadline formatter', () => {
		const env = { AIH_EVERGREEN_DEADLINE_FORMAT_V2_ENABLED: 'true' }
		expect(pilotDeadlineDisplay(berlin, env)).toBe(
			'Monday, October 5, 2026 at 11:59 PM Central European Summer Time',
		)
		expect(pilotDeadlineDisplay(pacific, env)).toBe(
			"Monday, October 5, 2026 at 11:59 PM Pacific Daylight Time (that's Tuesday, October 6 at 6:59 AM UTC)",
		)
	})
})
