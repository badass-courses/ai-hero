import type { InterestFactRequested } from '@/inngest/events/interest-fact'
import type { DrovrContactResolution } from '@/lib/subscriber-marketing/drovr-purchase-resolve'

import {
	drovrInterestFact,
	isInterestFieldKey,
	type DrovrInterestFact,
} from './interest-facts'
import type { LocalInterestFactResult } from './interest-fact-store'

export type InterestFactRecorderDeps = {
	findContactIdForEmail(email: string): Promise<string | undefined>
	writeLocalInterestFact(args: {
		contactId: string
		fieldKey: Parameters<typeof drovrInterestFact>[0]['fieldKey']
		at: string
	}): Promise<LocalInterestFactResult>
	/** Absent when drovr is not configured for this deployment. */
	drovr?: {
		resolve(email: string): Promise<DrovrContactResolution | undefined>
		record(fact: DrovrInterestFact): Promise<void>
	}
}

export type InterestFactRecordResult = {
	local: 'inserted' | 'existing' | 'no-contact' | 'no-identity' | 'invalid'
	drovr: 'recorded' | 'unresolved' | 'not-configured' | 'skipped'
}

/**
 * One join, written locally and then to drovr. The local row comes first so
 * drovr gets the first join's time: drovr keeps the first fact per source id,
 * and a second join with a later time would otherwise read as a conflict.
 *
 * A missing local contact or drovr contact is an answer, not an error: the
 * caller may wait for the signup to land and ask again. A drovr transport
 * failure throws so the job retries.
 */
export async function recordInterestFact(
	deps: InterestFactRecorderDeps,
	data: InterestFactRequested['data'],
): Promise<InterestFactRecordResult> {
	const at = new Date(data.expressedAt)
	if (!isInterestFieldKey(data.fieldKey) || !Number.isFinite(at.getTime())) {
		return { local: 'invalid', drovr: 'skipped' }
	}
	const fieldKey = data.fieldKey

	let local: InterestFactRecordResult['local'] = 'no-contact'
	let firstAt = at.toISOString()
	const contactId = await deps.findContactIdForEmail(data.email)
	if (contactId) {
		const written = await deps.writeLocalInterestFact({
			contactId,
			fieldKey,
			at: firstAt,
		})
		local = written.status
		if (written.status !== 'no-identity') firstAt = written.occurredAt
	}

	if (!deps.drovr) return { local, drovr: 'not-configured' }
	const resolution = await deps.drovr.resolve(data.email)
	if (resolution?.status !== 'resolved') return { local, drovr: 'unresolved' }
	await deps.drovr.record(
		drovrInterestFact({
			drovrContactId: resolution.contactId,
			fieldKey,
			at: firstAt,
		}),
	)
	return { local, drovr: 'recorded' }
}

/** Worth a wait: the signup that names this person may not have landed. */
export function shouldWaitForContact(result: InterestFactRecordResult) {
	return result.local === 'no-contact' || result.drovr === 'unresolved'
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** drovr's double opt-in confirm window: past it, nobody is coming. */
export const INTEREST_CONFIRM_WINDOW_MS = 7 * DAY_MS

/**
 * When a waiting join looks again, measured from when the join arrived:
 * soon for a signup still landing, then hourly-ish while a confirmation
 * email is fresh, then daily to the end of the confirm window.
 */
export const INTEREST_CHECK_OFFSETS_MS: readonly number[] = [
	15 * MINUTE_MS,
	HOUR_MS,
	3 * HOUR_MS,
	6 * HOUR_MS,
	12 * HOUR_MS,
	DAY_MS,
	2 * DAY_MS,
	3 * DAY_MS,
	4 * DAY_MS,
	5 * DAY_MS,
	6 * DAY_MS,
	INTEREST_CONFIRM_WINDOW_MS,
]

/**
 * Step ids for the nth look. The first keeps the ids of the single 15-minute
 * wait this replaced, so a run sleeping through the deploy carries on.
 */
export function interestCheckStepIds(index: number) {
	return index === 0
		? { sleep: 'wait-for-signup', check: 'record-interest-fact-after-wait' }
		: {
				sleep: `wait-for-confirm-${index}`,
				check: `record-interest-fact-after-wait-${index}`,
			}
}

export type InterestWaitOutcome = {
	result: InterestFactRecordResult
	/** `none` recorded at once, `attached` after a wait, `expired` gave up. */
	wait: 'none' | 'attached' | 'expired'
	checks: number
}

/**
 * Keep looking for a join's person until both stores know them or the
 * confirm window closes. The steps are the caller's (Inngest's sleepUntil
 * and run), so this holds the schedule and nothing durable. Each look is a
 * full recordInterestFact: the local write and the drovr fact both keep the
 * first join, so a look that repeats work records nothing twice.
 */
export async function waitForInterestContact(args: {
	/** When the join arrived (the Inngest event's ts), in epoch ms. */
	receivedAt: number
	first: InterestFactRecordResult
	sleepUntil(id: string, at: Date): Promise<unknown>
	check(id: string): Promise<InterestFactRecordResult>
}): Promise<InterestWaitOutcome> {
	if (!shouldWaitForContact(args.first)) {
		return { result: args.first, wait: 'none', checks: 1 }
	}
	let result = args.first
	let checks = 1
	for (const [index, offset] of INTEREST_CHECK_OFFSETS_MS.entries()) {
		const ids = interestCheckStepIds(index)
		await args.sleepUntil(ids.sleep, new Date(args.receivedAt + offset))
		result = await args.check(ids.check)
		checks += 1
		if (!shouldWaitForContact(result)) {
			return { result, wait: 'attached', checks }
		}
	}
	return { result, wait: 'expired', checks }
}
