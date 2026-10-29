import { after } from 'next/server'

import { drovrApiKeyForTenant } from './drovr-shadow-emitter'
import { resolveDrovrApiBaseUrl } from './drovr-unsubscribe-page'
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

/** Called only for saved, direct survey submissions, never /ask GET clicks. */
export async function deliverGoalInterestFact(args: {
	row: GoalAnswerSaved
	logger: Logger
	config: { baseUrl: string; apiKey: string }
	fetcher?: typeof fetch
}) {
	try {
		if (!args.row.email) {
			await logFailure(args.logger, args.row.id, 'missing-email')
			return
		}
		const resolutions = await resolveDrovrContacts({
			emails: [args.row.email],
			config: args.config,
			fetcher: args.fetcher,
		})
		const resolution = resolutions.get(normalizeResolveEmail(args.row.email))
		if (resolution?.status !== 'resolved') {
			await logFailure(args.logger, args.row.id, 'contact-unresolved')
			return
		}
		const fact = goalInterestFact({
			...args.row,
			contactId: resolution.contactId,
		})
		if (!fact) return
		await recordInterestFacts({
			facts: [fact],
			config: args.config,
			fetcher: args.fetcher,
		})
	} catch {
		await logFailure(args.logger, args.row.id, 'delivery-failed')
	}
}

/** Next keeps the task alive after the response; no provider round trip is on
 * the save/request path. Scheduling, transport and logging failures all stay
 * outside the survey's success result. No fallback to an untracked promise.
 */
export function scheduleGoalInterestFact(row: GoalAnswerSaved, logger: Logger) {
	if (process.env.AIH_DROVR_SURVEY_INTEREST_FACTS_ENABLED !== 'true') return
	if (!goalInterestFact({ ...row, contactId: 'validation-only' })) return
	try {
		after(async () => {
			try {
				const baseUrl = resolveDrovrApiBaseUrl({
					DROVR_API_BASE_URL: process.env.DROVR_API_BASE_URL,
					DROVR_SHADOW_INGEST_URL: process.env.DROVR_SHADOW_INGEST_URL,
				})
				const apiKey = drovrApiKeyForTenant('org-aihero')
				if (!baseUrl || !apiKey) {
					await logFailure(logger, row.id, 'not-configured')
					return
				}
				await deliverGoalInterestFact({
					row,
					logger,
					config: { baseUrl, apiKey },
				})
			} catch {
				await logFailure(logger, row.id, 'delivery-failed')
			}
		})
	} catch {
		void logFailure(logger, row.id, 'schedule-failed')
	}
}
