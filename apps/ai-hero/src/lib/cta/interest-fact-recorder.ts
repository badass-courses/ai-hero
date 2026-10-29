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

/** Worth one wait: the signup that names this person may not have landed. */
export function shouldWaitForContact(result: InterestFactRecordResult) {
	return result.local === 'no-contact' || result.drovr === 'unresolved'
}
