import { nextSkillsWorkflowEmailResourceId } from './skills-workflow-path'
import type { SideEffectIntent } from './types'
import {
	isValuePathIntentCompleted,
	valuePathIntentCompletedAt,
} from './value-path-completion'

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
 *
 * Scope must also be applied before the limit. In rolling-public-enrollment,
 * new learners are not members of the activation's original contact list. A
 * caller-side contact filter therefore hid the live cohort while old static
 * contacts consumed the limited frontier window (2026-07-17 regression).
 */
export type CompletedValuePathIntentScanArgs = {
	intents: SideEffectIntent[]
	limit: number
	maxCompletedAt?: string
	contactIds?: readonly string[]
	valuePathSlugs?: readonly string[]
	emailResourceIds?: readonly string[]
	kitSequenceIds?: readonly string[]
	now?: string
}

export type CompletedValuePathIntentScanDiagnostics = {
	scanned: number
	eligible: number
	frontierSize: number
	actionableFrontierSize: number
	returned: number
	truncated: number
	excludedMissingCompletedAt: number
	excludedByScope: number
	excludedTerminal: number
	excludedExistingNextIntent: number
	oldestFrontierCompletedAt?: string
	oldestFrontierAgeHours?: number
}

export function scanCompletedValuePathIntentFrontier(
	args: CompletedValuePathIntentScanArgs,
): {
	intents: SideEffectIntent[]
	diagnostics: CompletedValuePathIntentScanDiagnostics
} {
	let excludedMissingCompletedAt = 0
	let excludedByScope = 0
	const eligible = args.intents.filter((intent) => {
		if (!isValuePathIntentCompleted(intent)) return false
		const completedAt = valuePathIntentCompletedAt(intent)
		if (!completedAt) {
			excludedMissingCompletedAt += 1
			return false
		}
		if (args.maxCompletedAt && completedAt > args.maxCompletedAt) return false
		if (!matchesScanScope(intent, args)) {
			excludedByScope += 1
			return false
		}
		return true
	})
	const frontier = new Map<string, SideEffectIntent>()
	for (const intent of eligible) {
		const key = frontierKey(intent)
		const current = frontier.get(key)
		if (!current || compareByCompletion(intent, current) > 0) {
			frontier.set(key, intent)
		}
	}
	const orderedFrontier = Array.from(frontier.values()).sort(compareByCompletion)
	const intentSteps = new Set(args.intents.map(intentStepKey).filter(Boolean))
	let excludedTerminal = 0
	let excludedExistingNextIntent = 0
	const actionableFrontier = orderedFrontier.filter((intent) => {
		const nextStepKey = nextIntentStepKey(intent)
		if (!nextStepKey) {
			excludedTerminal += 1
			return false
		}
		if (intentSteps.has(nextStepKey)) {
			excludedExistingNextIntent += 1
			return false
		}
		return true
	})
	const intents = actionableFrontier.slice(0, args.limit)
	const oldestFrontierCompletedAt = valuePathIntentCompletedAt(
		actionableFrontier[0],
	)
	return {
		intents,
		diagnostics: {
			scanned: args.intents.length,
			eligible: eligible.length,
			frontierSize: orderedFrontier.length,
			actionableFrontierSize: actionableFrontier.length,
			returned: intents.length,
			truncated: Math.max(0, actionableFrontier.length - intents.length),
			excludedMissingCompletedAt,
			excludedByScope,
			excludedTerminal,
			excludedExistingNextIntent,
			oldestFrontierCompletedAt,
			oldestFrontierAgeHours: oldestFrontierCompletedAt
				? hoursBetween(oldestFrontierCompletedAt, args.now ?? new Date().toISOString())
				: undefined,
		},
	}
}

export function selectCompletedValuePathIntentFrontier(
	args: CompletedValuePathIntentScanArgs,
): SideEffectIntent[] {
	return scanCompletedValuePathIntentFrontier(args).intents
}

export function sortValuePathIntentsByCreatedAt(intents: SideEffectIntent[]) {
	return [...intents].sort(
		(a, b) => compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id),
	)
}

export function hasValidCompletedAt(intent: SideEffectIntent) {
	return isValuePathIntentCompleted(intent)
}

function matchesScanScope(
	intent: SideEffectIntent,
	args: CompletedValuePathIntentScanArgs,
) {
	return (
		matchesOptional(args.contactIds, intent.contactId) &&
		matchesOptional(args.valuePathSlugs, stringField(intent.metadata.valuePathSlug)) &&
		matchesOptional(
			args.emailResourceIds,
			stringField(intent.metadata.emailResourceId),
		) &&
		matchesOptional(args.kitSequenceIds, stringField(intent.metadata.kitSequenceId))
	)
}

function matchesOptional(values: readonly string[] | undefined, value?: string) {
	return !values || (value !== undefined && values.includes(value))
}

function frontierKey(intent: SideEffectIntent) {
	return `${intent.contactId}:${valuePathSlug(intent) ?? 'unknown-path'}`
}

function intentStepKey(intent: SideEffectIntent) {
	const slug = valuePathSlug(intent)
	const resourceId = stringField(intent.metadata.emailResourceId)
	return slug && resourceId ? `${intent.contactId}:${slug}:${resourceId}` : undefined
}

function nextIntentStepKey(intent: SideEffectIntent) {
	const slug = valuePathSlug(intent)
	const resourceId = stringField(intent.metadata.emailResourceId)
	if (!slug || !resourceId) return undefined
	const nextResourceId = nextSkillsWorkflowEmailResourceId(resourceId)
	return nextResourceId
		? `${intent.contactId}:${slug}:${nextResourceId}`
		: undefined
}

function valuePathSlug(intent: SideEffectIntent) {
	return stringField(intent.metadata.valuePathSlug)
}

function compareByCompletion(a: SideEffectIntent, b: SideEffectIntent) {
	return (
		compareStrings(
			valuePathIntentCompletedAt(a) ?? '',
			valuePathIntentCompletedAt(b) ?? '',
		) ||
		compareStrings(a.createdAt, b.createdAt) ||
		compareStrings(a.id, b.id)
	)
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function hoursBetween(from: string, to: string) {
	return Math.max(0, Math.round(((Date.parse(to) - Date.parse(from)) / 3_600_000) * 10) / 10)
}

function compareStrings(a: string, b: string) {
	if (a === b) return 0
	return a < b ? -1 : 1
}
