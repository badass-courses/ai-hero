import { emailEquivalenceKey } from '@/lib/subscriber-marketing/contact-email-equivalence'

import { shouldWaitForContact } from './interest-fact-recorder'

/**
 * Which waitlist and interest joins the old single 15-minute wait dropped,
 * so a re-drive can send them again (dry run only; see
 * scripts/interest-fact-redrive-dry-run.ts). A dropped join is a completed
 * run whose output says the person was still unknown, from before runs
 * learned to wait out the confirm window. A failed run is the drovr 403
 * class: drovr owns that replay, so it is counted, never re-driven.
 */

/** Interest facts went live (and double opt-in with it) at this deploy. */
export const INTEREST_REDRIVE_SINCE = '2026-10-29T19:35:00.000Z'

export type InterestRunClass =
	| 'dropped'
	| 'failed'
	| 'recorded'
	| 'waiting'
	| 'expired'
	| 'other'

export type InngestRun = { status?: string; output?: unknown }

export function classifyInterestRun(run: InngestRun): InterestRunClass {
	switch (run.status) {
		case 'Failed':
			return 'failed'
		case 'Running':
		case 'Queued':
		case 'Paused':
			return 'waiting'
		case 'Completed':
			break
		default:
			return 'other'
	}
	const output = run.output as
		| { local?: unknown; drovr?: unknown; wait?: unknown }
		| null
		| undefined
	if (!output || typeof output.local !== 'string') return 'other'
	if (output.wait === 'expired') return 'expired'
	const result = {
		local: output.local,
		drovr: output.drovr,
	} as Parameters<typeof shouldWaitForContact>[0]
	// No `wait` field: the run ended after one 15-minute look.
	if (output.wait === undefined && shouldWaitForContact(result)) {
		return 'dropped'
	}
	return 'recorded'
}

export type InterestRedriveEvent = {
	data: { email?: unknown; fieldKey?: unknown; via?: unknown }
	runs: InngestRun[]
}

export type ListedInngestEvent = {
	internal_id?: string
	data?: InterestRedriveEvent['data']
}

export type InngestEventPage = { data?: unknown[]; cursor?: string }

/**
 * Every page of an Inngest event listing. Inngest may clamp `limit` (to 51
 * today), so a short page is not the last one: keep going until a page is
 * empty or the cursor stops moving. The cursor is the body's `cursor`, else
 * the last event's id. Events are deduped by id in case pages overlap.
 */
export async function listAllInngestEvents(
	fetchPage: (cursor: string | undefined) => Promise<InngestEventPage>,
	maxPages: number,
) {
	const events = new Map<string, ListedInngestEvent>()
	let cursor: string | undefined
	let pages = 0
	let truncated = false
	while (true) {
		if (pages >= maxPages) {
			truncated = true
			break
		}
		const body = await fetchPage(cursor)
		pages += 1
		const data = (body.data ?? []) as ListedInngestEvent[]
		if (data.length === 0) break
		for (const event of data) {
			if (event.internal_id) events.set(event.internal_id, event)
		}
		const next = body.cursor || data.at(-1)?.internal_id
		if (!next || next === cursor) break
		cursor = next
	}
	return { events: [...events.values()], pages, truncated }
}

export type InterestRedrivePlan = {
	events: number
	runs: Record<InterestRunClass, number>
	/** Distinct person-and-list joins a re-drive would send. */
	wouldRedrive: number
	wouldRedriveByVia: Record<string, number>
	wouldRedriveByFieldKey: Record<string, number>
}

/**
 * Counts only. A join is re-driven once per email key and list, and not at
 * all when another run for it recorded the join or is still waiting.
 */
export function planInterestRedrive(
	events: InterestRedriveEvent[],
): InterestRedrivePlan {
	const runs: Record<InterestRunClass, number> = {
		dropped: 0,
		failed: 0,
		recorded: 0,
		waiting: 0,
		expired: 0,
		other: 0,
	}
	const dropped = new Map<string, { via: string; fieldKey: string }>()
	const settled = new Set<string>()
	for (const event of events) {
		const { email, fieldKey, via } = event.data
		const key =
			typeof email === 'string' && typeof fieldKey === 'string'
				? `${emailEquivalenceKey(email)}:${fieldKey}`
				: undefined
		for (const run of event.runs) {
			const kind = classifyInterestRun(run)
			runs[kind] += 1
			if (!key) continue
			if (kind === 'dropped') {
				dropped.set(key, {
					via: typeof via === 'string' ? via : 'unknown',
					fieldKey: fieldKey as string,
				})
			}
			if (kind === 'recorded' || kind === 'waiting') settled.add(key)
		}
	}
	const wouldRedriveByVia: Record<string, number> = {}
	const wouldRedriveByFieldKey: Record<string, number> = {}
	let wouldRedrive = 0
	for (const [key, join] of dropped) {
		if (settled.has(key)) continue
		wouldRedrive += 1
		wouldRedriveByVia[join.via] = (wouldRedriveByVia[join.via] ?? 0) + 1
		wouldRedriveByFieldKey[join.fieldKey] =
			(wouldRedriveByFieldKey[join.fieldKey] ?? 0) + 1
	}
	return {
		events: events.length,
		runs,
		wouldRedrive,
		wouldRedriveByVia,
		wouldRedriveByFieldKey,
	}
}

/**
 * The same count from the logs, which hold no address: every
 * `interest.fact.recorded` line is one finished run. Lines without `wait`
 * came from the single-wait code.
 */
export function interestRedriveAxiomQuery(projectName = 'ai-hero') {
	return [
		`['vercel']`,
		`| where ['vercel.projectName'] == '${projectName}' and message contains 'interest.fact.recorded'`,
		`| extend m = parse_json(message)`,
		`| where tostring(m.event) == 'interest.fact.recorded'`,
		`| extend local = tostring(m.local), drovr = tostring(m.drovr), wait = tostring(m.wait), via = tostring(m.via), fieldKey = tostring(m.fieldKey)`,
		`| summarize total = count() by local, drovr, wait, via, fieldKey`,
	].join(' ')
}

/** Failed runs of interest-fact-record: the held drovr 403 class. */
export function interestFailedRunsAxiomQuery(projectName = 'ai-hero') {
	return [
		`['vercel']`,
		`| where ['vercel.projectName'] == '${projectName}' and message contains 'inngest.function.failed' and message contains 'interest-fact-record'`,
		`| summarize total = count()`,
	].join(' ')
}

export type AxiomInterestRow = {
	local: string
	drovr: string
	wait: string
	via: string
	fieldKey: string
	total: number
}

/** Log rows to the dropped count: single-wait lines that still needed a wait. */
export function droppedFromLogRows(rows: AxiomInterestRow[]) {
	let dropped = 0
	let notDropped = 0
	const byVia: Record<string, number> = {}
	const byFieldKey: Record<string, number> = {}
	for (const row of rows) {
		const needsWait = shouldWaitForContact({
			local: row.local,
			drovr: row.drovr,
		} as Parameters<typeof shouldWaitForContact>[0])
		if (!row.wait && needsWait) {
			dropped += row.total
			byVia[row.via] = (byVia[row.via] ?? 0) + row.total
			byFieldKey[row.fieldKey] = (byFieldKey[row.fieldKey] ?? 0) + row.total
		} else {
			notDropped += row.total
		}
	}
	return { dropped, notDropped, byVia, byFieldKey }
}
