import { formatInTimeZone, zonedTimeToUtc } from 'date-fns-tz'

import {
	deadlineTimeZoneEvidenceFromHeader,
	type DeadlineTimeZoneEvidence,
} from '../course-sequence-exhaustion'
import type {
	EvergreenOfferJourneyDefinition,
	IssuedCoupon,
	MessageSlot,
	SelectedMessagePlan,
} from './domain'
import {
	parseIsoInstant,
	type IanaTimeZone,
	type IsoInstant,
} from './primitives'

export { deadlineTimeZoneEvidenceFromHeader }

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export type JourneyScheduleError = {
	readonly type: 'JourneyScheduleError'
	readonly reason:
		| 'InvalidInstant'
		| 'InvalidTimeZone'
		| 'InvalidCouponWindow'
		| 'NonMonotonicPitchSchedule'
	readonly detail: string
}

type JourneyScheduleFailure = {
	readonly ok: false
	readonly error: JourneyScheduleError
}

type ScheduleResult<Value> =
	| { readonly ok: true; readonly value: Value }
	| JourneyScheduleFailure

export function buildBridgeMessagePlan(args: {
	exhaustedAt: IsoInstant
	deadlineTimeZone: DeadlineTimeZoneEvidence
	definition: EvergreenOfferJourneyDefinition
}): ScheduleResult<{
	messagePlan: SelectedMessagePlan
	couponIssueAt: IsoInstant
}> {
	const timeZone = args.deadlineTimeZone.timeZone
	const earliestB1 = new Date(Date.parse(args.exhaustedAt) + 18 * HOUR_MS)
	const b1Due = firstLocalNineAtOrAfter({
		instant: earliestB1,
		timeZone,
	})
	const b2Due = localInstant({
		date: addLocalDays(localDate(b1Due, timeZone), 1),
		time: '09:00:00',
		timeZone,
	})
	const b3Due = localInstant({
		date: addLocalDays(localDate(b1Due, timeZone), 2),
		time: '09:00:00',
		timeZone,
	})
	const couponIssueAt = firstThursdayNineAtLeast24HoursAfter({
		instant: b3Due,
		timeZone,
	})
	const b1 = toIsoInstant(b1Due)
	const b2 = toIsoInstant(b2Due)
	const b3 = toIsoInstant(b3Due)
	const coupon = toIsoInstant(couponIssueAt)
	if (!b1.ok || !b2.ok || !b3.ok || !coupon.ok) {
		return scheduleError('InvalidInstant', 'Bridge schedule produced an invalid instant')
	}

	return {
		ok: true,
		value: {
			couponIssueAt: coupon.value,
			messagePlan: {
				definitionVersion: args.definition.definitionVersion,
				messagePlanId: args.definition.messagePlanId,
				messagePlanSourceHash: args.definition.messagePlanSourceHash,
				contentRevision: args.definition.contentRevision,
				presentationReviewRevision:
					args.definition.presentationReviewRevision,
				bridge: [
					scheduledSlot(
						args.definition.bridge[0],
						'Bridge',
						b1.value,
						b2.value,
					),
					scheduledSlot(
						args.definition.bridge[1],
						'Bridge',
						b2.value,
						b3.value,
					),
					scheduledSlot(
						args.definition.bridge[2],
						'Bridge',
						b3.value,
						coupon.value,
					),
				],
				pitch: [],
			},
		},
	}
}

export function addPitchMessagePlan(args: {
	messagePlan: SelectedMessagePlan
	coupon: IssuedCoupon
	definition: EvergreenOfferJourneyDefinition
}): ScheduleResult<SelectedMessagePlan> {
	const timeZone = args.coupon.deadlineTimeZone.timeZone
	const openingDate = localDate(new Date(args.coupon.issuedAt), timeZone)
	const p1 = new Date(args.coupon.issuedAt)
	const p2 = localInstant({
		date: addLocalDays(openingDate, 1),
		time: '09:00:00',
		timeZone,
	})
	const p3 = localInstant({
		date: addLocalDays(openingDate, 3),
		time: '09:00:00',
		timeZone,
	})
	const p4 = localInstant({
		date: addLocalDays(openingDate, 4),
		time: '09:00:00',
		timeZone,
	})
	const p5 = localInstant({
		date: addLocalDays(openingDate, 4),
		time: '20:00:00',
		timeZone,
	})
	const expiry = new Date(args.coupon.expiresAt)
	const expectedExpiry = localInstant({
		date: addLocalDays(openingDate, 4),
		time: '23:59:59',
		timeZone,
	})
	if (expiry.getTime() !== expectedExpiry.getTime()) {
		return scheduleError(
			'InvalidCouponWindow',
			'Coupon expiry does not match Monday 23:59:59 in the pinned time zone',
		)
	}
	const rawInstants = [p1, p2, p3, p4, p5, expiry]
	for (let index = 1; index < rawInstants.length; index += 1) {
		if (rawInstants[index]!.getTime() <= rawInstants[index - 1]!.getTime()) {
			return scheduleError(
				'NonMonotonicPitchSchedule',
				'Pitch slots must stay strictly ordered inside the coupon window',
			)
		}
	}
	const p1Due = toIsoInstant(p1)
	const p2Due = toIsoInstant(p2)
	const p3Due = toIsoInstant(p3)
	const p4Due = toIsoInstant(p4)
	const p5Due = toIsoInstant(p5)
	const expiresAt = toIsoInstant(expiry)
	if (
		!p1Due.ok ||
		!p2Due.ok ||
		!p3Due.ok ||
		!p4Due.ok ||
		!p5Due.ok ||
		!expiresAt.ok
	) {
		return scheduleError('InvalidInstant', 'Pitch schedule produced an invalid instant')
	}

	return {
		ok: true,
		value: {
			...args.messagePlan,
			pitch: [
				scheduledSlot(
					args.definition.pitch[0],
					'Pitch',
					p1Due.value,
					p2Due.value,
				),
				scheduledSlot(
					args.definition.pitch[1],
					'Pitch',
					p2Due.value,
					p3Due.value,
				),
				scheduledSlot(
					args.definition.pitch[2],
					'Pitch',
					p3Due.value,
					p4Due.value,
				),
				scheduledSlot(
					args.definition.pitch[3],
					'Pitch',
					p4Due.value,
					p5Due.value,
				),
				scheduledSlot(
					args.definition.pitch[4],
					'Pitch',
					p5Due.value,
					expiresAt.value,
				),
			],
		},
	}
}

export function couponExpiresAtForOpening(args: {
	openingAt: IsoInstant
	timeZone: IanaTimeZone
}): IsoInstant {
	const openingDate = localDate(new Date(args.openingAt), args.timeZone)
	const expiry = localInstant({
		date: addLocalDays(openingDate, 4),
		time: '23:59:59',
		timeZone: args.timeZone,
	})
	const parsed = toIsoInstant(expiry)
	if (!parsed.ok) throw new Error(parsed.error.detail)
	return parsed.value
}

function scheduledSlot(
	definition: EvergreenOfferJourneyDefinition['bridge'][number],
	phase: MessageSlot['phase'],
	dueAt: IsoInstant,
	windowEndsAt: IsoInstant,
): MessageSlot {
	return {
		...definition,
		phase,
		dueAt,
		windowEndsAt,
		status: 'Scheduled',
	}
}

function firstLocalNineAtOrAfter(args: {
	instant: Date
	timeZone: IanaTimeZone
}) {
	const date = localDate(args.instant, args.timeZone)
	const sameDay = localInstant({ date, time: '09:00:00', timeZone: args.timeZone })
	if (sameDay.getTime() >= args.instant.getTime()) return sameDay
	return localInstant({
		date: addLocalDays(date, 1),
		time: '09:00:00',
		timeZone: args.timeZone,
	})
}

function firstThursdayNineAtLeast24HoursAfter(args: {
	instant: Date
	timeZone: IanaTimeZone
}) {
	const earliest = new Date(args.instant.getTime() + DAY_MS)
	let date = localDate(earliest, args.timeZone)
	for (let index = 0; index < 8; index += 1) {
		const candidate = localInstant({
			date,
			time: '09:00:00',
			timeZone: args.timeZone,
		})
		if (weekday(date) === 4 && candidate.getTime() >= earliest.getTime()) {
			return candidate
		}
		date = addLocalDays(date, 1)
	}
	throw new Error('Could not resolve the Thursday coupon issue time')
}

function localDate(instant: Date, timeZone: IanaTimeZone) {
	return formatInTimeZone(instant, timeZone, 'yyyy-MM-dd')
}

function localInstant(args: {
	date: string
	time: string
	timeZone: IanaTimeZone
}) {
	return zonedTimeToUtc(`${args.date} ${args.time}`, args.timeZone)
}

function addLocalDays(date: string, days: number) {
	const noonUtc = new Date(`${date}T12:00:00.000Z`)
	noonUtc.setUTCDate(noonUtc.getUTCDate() + days)
	return noonUtc.toISOString().slice(0, 10)
}

function weekday(date: string) {
	return new Date(`${date}T12:00:00.000Z`).getUTCDay()
}

function toIsoInstant(value: Date): ScheduleResult<IsoInstant> {
	const parsed = parseIsoInstant(value.toISOString())
	return parsed.ok
		? parsed
		: scheduleError('InvalidInstant', 'Date could not become an ISO instant')
}

function scheduleError(
	reason: JourneyScheduleError['reason'],
	detail: string,
): JourneyScheduleFailure {
	return { ok: false, error: { type: 'JourneyScheduleError', reason, detail } }
}
