/**
 * Waitlist and interest joins as facts the site owns, not Kit fields.
 *
 * A join is one fact per person per field key: `waitlist_<product>` for a
 * cohort or event waitlist, `interest_<workshop>` for workshop interest. The
 * key is the same string Kit stores, so gating reads one shape whichever
 * store answered. The first join is the fact: a second click records nothing
 * new, locally or in drovr.
 *
 * Three switches, all off by default:
 * - `AIH_INTEREST_FACTS_ENABLED=true` records every join locally and in drovr.
 * - `AIH_INTEREST_FACTS_GATING=true` lets a signed-in reader's local facts
 *   answer "already joined".
 * - `AIH_INTEREST_KIT_WRITES=off` stops the one-click Kit field and tag
 *   writes. Flip it only after a materialized cohort count matches the Kit
 *   count for the live waitlist; it is the cut, the other two are not.
 */

/** ContactEvent.eventType for a local join. */
export const INTEREST_FACT_EVENT_TYPE = 'interest.expressed'

/** The campaign the site's contact-level facts live in, as for survey goals. */
export const INTEREST_FACTS_CAMPAIGN_ID = 'contact-segments'

const FIELD_KEY = /^(waitlist|interest)_[a-z0-9_]{1,120}$/

export type InterestFieldKey = `waitlist_${string}` | `interest_${string}`

export function isInterestFieldKey(key: string): key is InterestFieldKey {
	return FIELD_KEY.test(key)
}

/** The waitlist and interest keys a form or contract sets to a value. */
export function interestFieldKeysOf(fields: unknown): InterestFieldKey[] {
	if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return []
	return Object.entries(fields as Record<string, unknown>)
		.filter(
			([key, value]) =>
				isInterestFieldKey(key) &&
				typeof value === 'string' &&
				value.trim().length > 0,
		)
		.map(([key]) => key as InterestFieldKey)
}

type Env = Record<string, string | undefined>

export function interestFactsEnabled(env: Env = process.env): boolean {
	return env.AIH_INTEREST_FACTS_ENABLED === 'true'
}

export function interestFactsGatingEnabled(env: Env = process.env): boolean {
	return env.AIH_INTEREST_FACTS_GATING === 'true'
}

/** Kit stays written unless the cut is explicit. Anything else keeps Kit. */
export function interestKitWritesEnabled(env: Env = process.env): boolean {
	return env.AIH_INTEREST_KIT_WRITES !== 'off'
}

/** One local fact per contact and key; the unique index makes a repeat a no-op. */
export function localInterestFactKey(contactId: string, fieldKey: string) {
	return `ai-hero:${INTEREST_FACT_EVENT_TYPE}:${contactId}:${fieldKey}`
}

/** ContactEvent.providerReference: the field key, readable by gating. */
export function localInterestFactReference(fieldKey: InterestFieldKey) {
	return `interest:${fieldKey}`
}

/**
 * Gating fields from local fact rows: `{ waitlist_x: '2026-10-29' }`, the
 * same ISO date value Kit holds. Rows that are not a well-formed fact are
 * ignored rather than trusted.
 */
export function interestFieldsFromFacts(
	rows: readonly { providerReference: string; occurredAt: Date | string }[],
): Record<string, string> {
	const fields: Record<string, string> = {}
	for (const row of rows) {
		const key = row.providerReference.startsWith('interest:')
			? row.providerReference.slice('interest:'.length)
			: ''
		const at = new Date(row.occurredAt)
		if (!isInterestFieldKey(key) || !Number.isFinite(at.getTime())) continue
		const date = at.toISOString().slice(0, 10)
		const earliest = fields[key]
		if (!earliest || date < earliest) fields[key] = date
	}
	return fields
}

export type DrovrInterestFact = {
	contactId: string
	at: string
	kind: 'aihero.waitlist' | 'aihero.interest'
	role: InterestFieldKey
	sourceId: string
}

/**
 * The drovr fact for one join. `kind` separates waitlists from interest and
 * `role` names the list, so a launch policy weights exactly one list, e.g.
 * `{ kind: 'aihero.waitlist', role: 'waitlist_ai_coding_crash_course' }`.
 * The source id holds no email and is stable per person and list, so drovr
 * records a join once however often it is replayed.
 */
export function drovrInterestFact(args: {
	drovrContactId: string
	fieldKey: InterestFieldKey
	at: string
}): DrovrInterestFact {
	return {
		contactId: args.drovrContactId,
		at: new Date(args.at).toISOString(),
		kind: args.fieldKey.startsWith('waitlist_')
			? 'aihero.waitlist'
			: 'aihero.interest',
		role: args.fieldKey,
		sourceId: JSON.stringify([
			'aihero',
			INTEREST_FACT_EVENT_TYPE,
			args.fieldKey,
			args.drovrContactId,
		]),
	}
}
