import { formatInTimeZone } from 'date-fns-tz'
import { expect, it } from 'vitest'
import {
	couponOpeningWeekday,
	firstCouponOpeningAtLeast24HoursAfter,
	couponExpiresAtForOpening,
	buildBridgeMessagePlan,
	addPitchMessagePlan,
	deadlineTimeZoneEvidenceFromHeader,
} from './calendar'
import { EVERGREEN_OFFER_JOURNEY_V2 } from './definition'
import {
	parseIanaTimeZone,
	parseIsoInstant,
	parseCouponId,
	parseContactId,
} from './primitives'

function zone(text: string) {
	const parsed = parseIanaTimeZone(text)
	if (!parsed.ok) throw new Error('Invalid test zone')
	return parsed.value
}
function instant(text: string) {
	const parsed = parseIsoInstant(text)
	if (!parsed.ok) throw new Error('Invalid test time')
	return parsed.value
}

it.each([
	'evergreen-offer-v1',
	'historical-custom-version',
	'evergreen-offer-v2-preview',
	'',
])(
	'preserves Thursday for historical free-string version %s',
	(definitionVersion) => {
		expect(couponOpeningWeekday(definitionVersion)).toBe(4)
		expect(
			firstCouponOpeningAtLeast24HoursAfter({
				instant: new Date('2026-09-07T16:00:00.000Z'),
				timeZone: zone('America/Los_Angeles'),
				definitionVersion,
			}).toISOString(),
		).toBe('2026-09-10T16:00:00.000Z')
	},
)

it.each([
	['2026-09-10T16:00:00.000Z', '2026-09-11T16:00:00.000Z'],
	['2026-09-10T16:00:00.001Z', '2026-09-18T16:00:00.000Z'],
	['2026-09-11T16:00:00.000Z', '2026-09-18T16:00:00.000Z'],
	['2026-12-30T17:00:00.000Z', '2027-01-01T17:00:00.000Z'],
])('Friday opening honors 24 elapsed hours from %s', (b3, expected) => {
	const opening = firstCouponOpeningAtLeast24HoursAfter({
		instant: new Date(b3),
		timeZone: zone('America/Los_Angeles'),
		definitionVersion: 'evergreen-offer-v2',
	})
	expect(opening.toISOString()).toBe(expected)
	expect(opening.getTime() - Date.parse(b3)).toBeGreaterThanOrEqual(86_400_000)
})

it.each([
	[
		'America/Los_Angeles',
		'2026-03-05T17:00:00.000Z',
		'2026-03-06T17:00:00.000Z',
		'2026-03-11T06:59:59.000Z',
	],
	[
		'America/Los_Angeles',
		'2026-10-29T16:00:00.000Z',
		'2026-10-30T16:00:00.000Z',
		'2026-11-04T07:59:59.000Z',
	],
	[
		'Pacific/Kiritimati',
		'2026-09-09T19:00:00.000Z',
		'2026-09-10T19:00:00.000Z',
		'2026-09-15T09:59:59.000Z',
	],
	[
		'Pacific/Honolulu',
		'2026-09-10T19:00:00.000Z',
		'2026-09-11T19:00:00.000Z',
		'2026-09-16T09:59:59.000Z',
	],
])(
	'uses local Friday/Tuesday in %s across DST and UTC boundaries',
	(tz, b3, expected, expires) => {
		const opening = firstCouponOpeningAtLeast24HoursAfter({
			instant: new Date(b3),
			timeZone: zone(tz),
			definitionVersion: 'evergreen-offer-v2',
		})
		expect(opening.toISOString()).toBe(expected)
		expect(formatInTimeZone(opening, tz, 'EEEE HH:mm:ss')).toBe(
			'Friday 09:00:00',
		)
		const expiry = couponExpiresAtForOpening({
			openingAt: instant(expected),
			timeZone: zone(tz),
		})
		expect(expiry).toBe(expires)
		expect(formatInTimeZone(new Date(expiry), tz, 'EEEE HH:mm:ss')).toBe(
			'Tuesday 23:59:59',
		)
	},
)

it.each(['2026-02-27T17:00:00.000Z', '2026-10-23T16:00:00.000Z'])(
	'keeps all five local pitch times across DST from %s',
	(exhaustedAt) => {
		const tz = 'America/Los_Angeles'
		const evidence = deadlineTimeZoneEvidenceFromHeader({
			headerValue: tz,
			capturedAt: instant(exhaustedAt),
		})
		const couponId = parseCouponId('dst-coupon')
		const contactId = parseContactId('dst-contact')
		if (!evidence.ok || !couponId.ok || !contactId.ok)
			throw new Error('Bad test identity')
		const bridge = buildBridgeMessagePlan({
			exhaustedAt: instant(exhaustedAt),
			deadlineTimeZone: evidence.value,
			definition: EVERGREEN_OFFER_JOURNEY_V2,
		})
		if (!bridge.ok) throw new Error(bridge.error.detail)
		const expiresAt = couponExpiresAtForOpening({
			openingAt: bridge.value.couponIssueAt,
			timeZone: zone(tz),
		})
		const pitch = addPitchMessagePlan({
			messagePlan: bridge.value.messagePlan,
			definition: EVERGREEN_OFFER_JOURNEY_V2,
			coupon: {
				couponId: couponId.value,
				contactId: contactId.value,
				issuedAt: bridge.value.couponIssueAt,
				expiresAt,
				deadlineTimeZone: evidence.value,
				terms: EVERGREEN_OFFER_JOURNEY_V2.couponTerms,
				binding: { type: 'AwaitingVerifiedUser' },
			},
		})
		if (!pitch.ok) throw new Error(pitch.error.detail)
		expect(
			pitch.value.pitch.map((slot) =>
				formatInTimeZone(new Date(slot.dueAt), tz, 'EEEE HH:mm:ss'),
			),
		).toEqual([
			'Friday 09:00:00',
			'Saturday 09:00:00',
			'Monday 09:00:00',
			'Tuesday 09:00:00',
			'Tuesday 20:00:00',
		])
		const times = [
			...pitch.value.pitch.map((slot) => Date.parse(slot.dueAt)),
			Date.parse(expiresAt),
		]
		expect(times.every((at, index) => !index || at > times[index - 1]!)).toBe(
			true,
		)
		const weekendHours = (times[2]! - times[1]!) / 3_600_000
		expect(weekendHours).toBe(exhaustedAt.startsWith('2026-02') ? 47 : 49)
	},
)
