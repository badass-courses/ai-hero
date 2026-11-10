import { after } from 'next/server'

import { INTEREST_FACT_REQUESTED_EVENT } from '@/inngest/events/interest-fact'

import {
	normalizeResolveEmail,
	resolveDrovrContacts,
} from './drovr-purchase-resolve'
import {
	goalInterestFact,
	type SurveyInterestFact,
} from './survey-interest-facts'

export type GoalAnswerSaved = {
	id: string
	questionId: string
	answer: string
	createdAt: Date
	email: string | null
}
type Logger = { info(event: string, data: Record<string, unknown>): unknown }

/** Never expose provider errors: bodies and messages can contain customer data. */
async function logFailure(logger: Logger, rowId: string, reason: string) {
	try {
		await logger.info('survey.interest_fact.failed', { rowId, reason })
	} catch {
		/* logging cannot fail the survey */
	}
}

export async function recordInterestFacts(args: {
	facts: readonly (
		| SurveyInterestFact
		| {
				contactId: string
				at: string
				kind: string
				role: string
				sourceId: string
		  }
	)[]
	config: { baseUrl: string; apiKey: string }
	fetcher?: typeof fetch
	/** A conflict on one of these source ids means drovr already holds the
	 * first fact for it, which stands; anything else is still refused. */
	firstWins?: boolean
}) {
	if (args.facts.length === 0 || args.facts.length > 500)
		throw new Error('invalid-fact-batch-size')
	const response = await (args.fetcher ?? fetch)(
		`${args.config.baseUrl.replace(/\/+$/, '')}/record_interest_facts`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${args.config.apiKey}`,
				'content-type': 'application/json',
				accept: 'application/json',
			},
			body: JSON.stringify({
				tenantId: 'org-aihero',
				campaignId: 'contact-segments',
				facts: args.facts,
			}),
			signal: AbortSignal.timeout(10_000),
		},
	)
	if (!response.ok) throw new Error('interest-fact-http-failed')
	const body: unknown = await response.json()
	if (
		!body ||
		typeof body !== 'object' ||
		!('inserted' in body) ||
		!('duplicates' in body) ||
		!('conflicts' in body) ||
		typeof body.inserted !== 'number' ||
		typeof body.duplicates !== 'number' ||
		!Array.isArray(body.conflicts) ||
		(body.conflicts.length > 0 &&
			(!args.firstWins ||
				!body.conflicts.every((id) =>
					args.facts.some((fact) => fact.sourceId === id),
				))) ||
		body.inserted + body.duplicates + body.conflicts.length !==
			args.facts.length
	) {
		throw new Error('interest-fact-not-acknowledged')
	}
}

/** Records one saved survey goal answer in drovr. Transport failures throw so
 * the Inngest step retries; the fact's immutable sourceId makes a retry or a
 * repeated event a duplicate on drovr's side. */
export async function recordGoalInterestFact(args: {
	row: GoalAnswerSaved
	config: { baseUrl: string; apiKey: string }
	fetcher?: typeof fetch
}): Promise<'recorded' | 'missing-email' | 'unresolved' | 'ignored'> {
	if (!goalInterestFact({ ...args.row, contactId: 'validation-only' }))
		return 'ignored'
	if (!args.row.email) return 'missing-email'
	const resolutions = await resolveDrovrContacts({
		emails: [args.row.email],
		config: args.config,
		fetcher: args.fetcher,
	})
	const resolution = resolutions.get(normalizeResolveEmail(args.row.email))
	if (resolution?.status !== 'resolved') return 'unresolved'
	const fact = goalInterestFact({
		...args.row,
		contactId: resolution.contactId,
	})
	if (!fact) return 'ignored'
	await recordInterestFacts({
		facts: [fact],
		config: args.config,
		fetcher: args.fetcher,
	})
	return 'recorded'
}

/** Sends the survey goal fact to the interest-fact-record Inngest function,
 * which retries drovr failures. Next keeps the task alive after the response;
 * no provider round trip is on the save/request path. Scheduling, send and
 * logging failures all stay outside the survey's success result. No fallback
 * to an untracked promise.
 */
export function scheduleGoalInterestFact(row: GoalAnswerSaved, logger: Logger) {
	if (process.env.AIH_DROVR_SURVEY_INTEREST_FACTS_ENABLED !== 'true') return
	if (!goalInterestFact({ ...row, contactId: 'validation-only' })) return
	if (!row.email) {
		void logFailure(logger, row.id, 'missing-email')
		return
	}
	const email = row.email.trim()
	try {
		after(async () => {
			try {
				const { inngest } = await import('@/inngest/inngest.server')
				await inngest.send({
					id: `survey-goal-fact:${row.id}`,
					name: INTEREST_FACT_REQUESTED_EVENT,
					data: {
						email,
						fieldKey: `survey_goal:${row.id}`,
						expressedAt: row.createdAt.toISOString(),
						via: 'survey',
						survey: {
							rowId: row.id,
							questionId: row.questionId,
							answer: row.answer,
						},
					},
				})
			} catch {
				await logFailure(logger, row.id, 'enqueue-failed')
			}
		})
	} catch {
		void logFailure(logger, row.id, 'schedule-failed')
	}
}
