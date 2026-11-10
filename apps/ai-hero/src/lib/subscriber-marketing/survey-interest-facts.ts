import type { DrovrContactResolution } from './drovr-purchase-resolve'
import {
	MAX_PLAUSIBLE_ANSWER_CLICKS_PER_CONTACT,
	MAX_PLAUSIBLE_ANSWER_CLICKS_PER_STEP,
} from './value-path-answer-click-verification'

export const SCOPE_QUESTION_ID = 'ai-hero-skills-workflow.email-0'
export const GOAL_QUESTION_ID = 'aih_value_path_next_path_interest'
export const GOAL_RESOURCE_ID = 'question-skills-workflow-completion-next-path'
export const SCOPE_ROLES = ['personal', 'team', 'unsure'] as const
export const GOAL_ROLES = [
	'ship_first_ai_feature',
	'improve_existing_codebase',
	'run_agents_safely_afk',
	'team_workflows',
	'ai_fundamentals_judgment',
] as const

export type SurveyInterestFact = {
	contactId: string
	at: string
	kind: `survey.answer.${'stated' | 'inferred'}.${string}`
	role: string
	sourceId: string
}

export function goalInterestFact(args: {
	id: string
	questionId: string
	answer: string
	createdAt: Date
	contactId: string
}): SurveyInterestFact | undefined {
	if (
		![GOAL_QUESTION_ID, GOAL_RESOURCE_ID].includes(args.questionId) ||
		!GOAL_ROLES.some((role) => role === args.answer)
	)
		return undefined
	return {
		contactId: args.contactId,
		at: args.createdAt.toISOString(),
		kind: `survey.answer.stated.${GOAL_QUESTION_ID}`,
		role: args.answer,
		sourceId: JSON.stringify(['aihero', 'AI_QuestionResponse', args.id]),
	}
}

export type ScopeAnswerSource = {
	id: string
	contactId: string
	email: string | null
	occurredAt: string
	keywords: string[]
	/** All answer-selected rows for this contact, not only scope rows. */
	contactClicks: number
	/** All scope answer-selected rows, before option filtering. */
	stepClicks: number
}

/** No per-event scanner flag exists. Reuse the app's volume classification,
 * then quarantine ambiguous multi-option scope selections rather than calling
 * any of them a human statement. Repeated source IDs alone are duplicates;
 * different immutable rows remain different facts, including repeat answers.
 */
export function planScopeInterestFacts(args: {
	rows: readonly ScopeAnswerSource[]
	resolved: ReadonlyMap<string, DrovrContactResolution>
}) {
	const optionsByContact = new Map<string, Set<string>>()
	for (const row of args.rows) {
		const options = optionsByContact.get(row.contactId) ?? new Set<string>()
		for (const role of SCOPE_ROLES)
			if (row.keywords.includes(role)) options.add(role)
		optionsByContact.set(row.contactId, options)
	}
	const counts = {
		sourceRows: args.rows.length,
		scannerDrops: 0,
		ambiguousDrops: 0,
		invalidDrops: 0,
		duplicates: 0,
		unresolvedRows: 0,
		unresolvedContacts: 0,
		missingContacts: 0,
		conflictContacts: 0,
		byRole: { personal: 0, team: 0, unsure: 0 },
	}
	const seen = new Set<string>()
	const unresolved = new Map<string, string>()
	const facts: SurveyInterestFact[] = []
	for (const row of args.rows) {
		const sourceId = JSON.stringify(['aihero', 'AI_ContactEvent', row.id])
		if (seen.has(sourceId)) {
			counts.duplicates++
			continue
		}
		seen.add(sourceId)
		if (
			row.contactClicks > MAX_PLAUSIBLE_ANSWER_CLICKS_PER_CONTACT ||
			row.stepClicks > MAX_PLAUSIBLE_ANSWER_CLICKS_PER_STEP
		) {
			counts.scannerDrops++
			continue
		}
		if ((optionsByContact.get(row.contactId)?.size ?? 0) > 1) {
			counts.ambiguousDrops++
			continue
		}
		const roles = SCOPE_ROLES.filter((role) => row.keywords.includes(role))
		const role = roles[0]
		if (
			!row.keywords.includes(SCOPE_QUESTION_ID) ||
			roles.length !== 1 ||
			!role ||
			!Number.isFinite(Date.parse(row.occurredAt))
		) {
			counts.invalidDrops++
			continue
		}
		const resolution = row.email
			? args.resolved.get(row.email.trim().toLowerCase())
			: undefined
		if (resolution?.status !== 'resolved' || !resolution.contactId) {
			counts.unresolvedRows++
			unresolved.set(row.contactId, resolution?.status ?? 'missing')
			continue
		}
		facts.push({
			contactId: resolution.contactId,
			at: new Date(row.occurredAt).toISOString(),
			// Legacy email clicks have no affirmative human-confirmation marker.
			// Desk ruling: eligible historical clicks are inferred, never stated.
			kind: `survey.answer.inferred.${SCOPE_QUESTION_ID}`,
			role,
			sourceId,
		})
		counts.byRole[role]++
	}
	counts.unresolvedContacts = unresolved.size
	for (const status of unresolved.values()) {
		if (status === 'conflict') counts.conflictContacts++
		else counts.missingContacts++
	}
	return { facts, counts }
}
