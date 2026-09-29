import type { DeadlineTimeZoneEvidence } from './course-sequence-exhaustion'

/**
 * The one formatter for an evergreen offer deadline. The Kit fields the pitch
 * emails print and the offer page's "ended" notice both come from here, so a
 * reader sees the same string in the email and on the page.
 *
 * Joel's copy rule (2026-09-29): an absolute date and time with the long zone
 * name, "Monday, October 5, 2026 at 11:59 PM Central European Summer Time".
 * Nothing relative, never "midnight", no bare "your time". When the zone is a
 * fallback rather than the contact's own, the text adds the UTC equivalent so
 * a reader outside the Pacific can place it.
 *
 * The time shown is the coupon row's `expires` in the zone drovr pinned. drovr
 * sets that to 23:59:59 local, so the minute-precision text reads 11:59 PM.
 */

export type OfferDeadlineZoneSource = 'vercel-header' | 'fallback'

export type OfferDeadline = {
	readonly expiresAt: string
	readonly timeZone: string
	readonly source: OfferDeadlineZoneSource
}

export type OfferDeadlineStyle = 'long' | 'short'

/**
 * Which deadline text the Kit fields and pilot messages carry. `legacy` is today's short-zone
 * string. `absolute` is Joel's copy rule from `formatOfferDeadline`, plus the
 * preview's short field. Kit sequence emails already in flight print these
 * fields, so the switch stays off until Joel approves the exact copy.
 */
export type EvergreenDeadlineFormat = 'legacy' | 'absolute'

export function evergreenDeadlineFormat(
	env: Record<string, string | undefined>,
): EvergreenDeadlineFormat {
	return env.AIH_EVERGREEN_DEADLINE_FORMAT_V2_ENABLED?.trim() === 'true'
		? 'absolute'
		: 'legacy'
}

export function offerDeadlineFromEvidence(
	expiresAt: string,
	evidence: Pick<DeadlineTimeZoneEvidence, 'type' | 'timeZone'>,
): OfferDeadline {
	return {
		expiresAt,
		timeZone: evidence.timeZone,
		source: evidence.type === 'BrowserEntryHeader' ? 'vercel-header' : 'fallback',
	}
}

/**
 * Short zone names, keyed by the long name Intl gives in en-US. Intl's own
 * short names are US-centric: outside North America it prints "GMT+2" where a
 * reader expects "CEST". Keying on the long name keeps a shared abbreviation
 * with the zone its readers know it for: "Pacific Standard Time" is PST and
 * "Central Standard Time" is CST, while China Standard Time and Philippine
 * Standard Time are absent and print their UTC offset instead.
 */
const SHORT_ZONE_NAMES: Readonly<Record<string, string>> = {
	'Hawaii-Aleutian Standard Time': 'HST',
	'Hawaii-Aleutian Daylight Time': 'HDT',
	'Alaska Standard Time': 'AKST',
	'Alaska Daylight Time': 'AKDT',
	'Pacific Standard Time': 'PST',
	'Pacific Daylight Time': 'PDT',
	'Mountain Standard Time': 'MST',
	'Mountain Daylight Time': 'MDT',
	'Central Standard Time': 'CST',
	'Central Daylight Time': 'CDT',
	'Eastern Standard Time': 'EST',
	'Eastern Daylight Time': 'EDT',
	'Atlantic Standard Time': 'AST',
	'Atlantic Daylight Time': 'ADT',
	'Newfoundland Standard Time': 'NST',
	'Newfoundland Daylight Time': 'NDT',
	'Brasilia Standard Time': 'BRT',
	'Argentina Standard Time': 'ART',
	'Colombia Standard Time': 'COT',
	'Peru Standard Time': 'PET',
	'Coordinated Universal Time': 'UTC',
	'Greenwich Mean Time': 'GMT',
	'British Summer Time': 'BST',
	'Western European Standard Time': 'WET',
	'Western European Summer Time': 'WEST',
	'Central European Standard Time': 'CET',
	'Central European Summer Time': 'CEST',
	'Eastern European Standard Time': 'EET',
	'Eastern European Summer Time': 'EEST',
	'Moscow Standard Time': 'MSK',
	'Türkiye Standard Time': 'TRT',
	'South Africa Standard Time': 'SAST',
	'Gulf Standard Time': 'GST',
	'Pakistan Standard Time': 'PKT',
	'India Standard Time': 'IST',
	'Indochina Time': 'ICT',
	'Western Indonesia Time': 'WIB',
	'Singapore Standard Time': 'SGT',
	'Hong Kong Standard Time': 'HKT',
	'Japan Standard Time': 'JST',
	'Korean Standard Time': 'KST',
	'Australian Western Standard Time': 'AWST',
	'Australian Central Standard Time': 'ACST',
	'Australian Central Daylight Time': 'ACDT',
	'Australian Eastern Standard Time': 'AEST',
	'Australian Eastern Daylight Time': 'AEDT',
	'New Zealand Standard Time': 'NZST',
	'New Zealand Daylight Time': 'NZDT',
}

/** A zone name Intl could not spell out: "GMT+01:00", "GMT-3", "GMT". */
const OFFSET_ZONE_NAME = /^(GMT|UTC)([+-]\d{1,2}(:\d{2})?)?$/

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
	const found = parts.find((item) => item.type === type)
	if (!found) throw new Error(`offer deadline: Intl omitted ${type}`)
	return found.value
}

function zoneName(
	date: Date,
	timeZone: string,
	style: 'long' | 'shortOffset' | 'longOffset',
) {
	return part(
		new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: style }).formatToParts(date),
		'timeZoneName',
	)
}

/** "UTC+5:30", "UTC-3", "UTC": the offset form, spelled with UTC not GMT. */
function utcOffsetName(date: Date, timeZone: string) {
	return zoneName(date, timeZone, 'shortOffset').replace(/^GMT/, 'UTC')
}

/** The long zone name, or the UTC offset where Intl has no name for it. */
export function longZoneName(date: Date, timeZone: string) {
	const name = zoneName(date, timeZone, 'long')
	return OFFSET_ZONE_NAME.test(name) ? utcOffsetName(date, timeZone) : name
}

/** The short zone name from our table, or the UTC offset on a miss. */
export function shortZoneName(date: Date, timeZone: string) {
	return (
		SHORT_ZONE_NAMES[zoneName(date, timeZone, 'long')] ??
		utcOffsetName(date, timeZone)
	)
}

function clock(parts: Intl.DateTimeFormatPart[]) {
	return `${part(parts, 'hour')}:${part(parts, 'minute')} ${part(parts, 'dayPeriod')}`
}

function longText(date: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
	}).formatToParts(date)
	return `${part(parts, 'weekday')}, ${part(parts, 'month')} ${part(parts, 'day')}, ${part(parts, 'year')} at ${clock(parts)} ${longZoneName(date, timeZone)}`
}

/** "that's Tuesday, October 6 at 6:59 AM UTC": the fallback's callback. */
function utcCallback(date: Date) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'UTC',
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
	}).formatToParts(date)
	return `that's ${part(parts, 'weekday')}, ${part(parts, 'month')} ${part(parts, 'day')} at ${clock(parts)} UTC`
}

function shortText(date: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
	}).formatToParts(date)
	return `${part(parts, 'weekday')} ${part(parts, 'month')} ${part(parts, 'day')}, ${clock(parts)} ${shortZoneName(date, timeZone)}`
}

/**
 * `long` is the body and page text. `short` is the one form allowed in an
 * email preview line ("Mon Oct 5, 11:59 PM CEST"); it has no room for the UTC
 * callback, so it carries only the pinned zone's own abbreviation.
 */
export function formatOfferDeadline(
	deadline: OfferDeadline,
	style: OfferDeadlineStyle = 'long',
): string {
	const date = new Date(deadline.expiresAt)
	if (!Number.isFinite(date.getTime()))
		throw new Error(`offer deadline: invalid instant ${deadline.expiresAt}`)
	if (style === 'short') return shortText(date, deadline.timeZone)
	const text = longText(date, deadline.timeZone)
	return deadline.source === 'vercel-header' ? text : `${text} (${utcCallback(date)})`
}
