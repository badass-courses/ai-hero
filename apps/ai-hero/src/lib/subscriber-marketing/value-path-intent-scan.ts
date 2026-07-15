import type { SideEffectIntent } from './types'

/**
 * Deterministic scan helpers for value-path email side-effect intents.
 *
 * Regression context (2026-07): the completed-intent scan used to return
 * rows in arbitrary database order and slice to the limit. Once total
 * completed intents exceeded the scan limit, the hourly drip cron rescanned
 * the same saturated window forever and never reached the progression
 * frontier, silently stalling the live cohort. The drip planner only needs
 * each contact's latest completed email per value path (the frontier), so
 * the scan reduces to at most one intent per contact/path before applying
 * the limit, ordered oldest-frontier-first so the most starved contacts are
 * served first even when the limit binds.
 */
export function selectCompletedValuePathIntentFrontier(args: {
	intents: SideEffectIntent[]
	limit: number
	maxCompletedAt?: string
}): SideEffectIntent[] {
	const eligible = args.intents.filter((intent) => {
		const completedAt = completedAtField(intent)
		if (!completedAt) return false
		return !args.maxCompletedAt || completedAt <= args.maxCompletedAt
	})
	const frontier = new Map<string, SideEffectIntent>()
	for (const intent of eligible) {
		const key = frontierKey(intent)
		const current = frontier.get(key)
		if (!current || compareByCompletion(intent, current) > 0) {
			frontier.set(key, intent)
		}
	}
	return Array.from(frontier.values())
		.sort(compareByCompletion)
		.slice(0, args.limit)
}

export function sortValuePathIntentsByCreatedAt(intents: SideEffectIntent[]) {
	return [...intents].sort(
		(a, b) => compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id),
	)
}

function frontierKey(intent: SideEffectIntent) {
	const slug =
		typeof intent.metadata.valuePathSlug === 'string' &&
		intent.metadata.valuePathSlug.length > 0
			? intent.metadata.valuePathSlug
			: 'unknown-path'
	return `${intent.contactId}:${slug}`
}

function compareByCompletion(a: SideEffectIntent, b: SideEffectIntent) {
	return (
		compareStrings(completedAtField(a) ?? '', completedAtField(b) ?? '') ||
		compareStrings(a.createdAt, b.createdAt) ||
		compareStrings(a.id, b.id)
	)
}

function completedAtField(intent: SideEffectIntent) {
	return typeof intent.metadata.completedAt === 'string' &&
		intent.metadata.completedAt.length > 0
		? intent.metadata.completedAt
		: undefined
}

function compareStrings(a: string, b: string) {
	if (a === b) return 0
	return a < b ? -1 : 1
}
