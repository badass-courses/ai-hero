import {
	INTEREST_FACT_REQUESTED_EVENT,
	type InterestFactRequested,
} from '@/inngest/events/interest-fact'
import { inngest } from '@/inngest/inngest.server'
import type { PendingInterestStore } from '@/lib/cta/interest-fact-pending'
import { isInterestFieldKey } from '@/lib/cta/interest-facts'
import {
	recordInterestFact,
	waitForInterestContact,
	type InterestFactRecorderDeps,
} from '@/lib/cta/interest-fact-recorder'

async function liveDeps(): Promise<InterestFactRecorderDeps> {
	const [
		{ db },
		store,
		{ drovrApiKeyForTenant },
		{ resolveDrovrApiBaseUrl },
		{ normalizeResolveEmail, resolveDrovrContacts },
		{ recordInterestFacts },
	] = await Promise.all([
		import('@/db'),
		import('@/lib/cta/interest-fact-store'),
		import('@/lib/subscriber-marketing/drovr-shadow-emitter'),
		import('@/lib/subscriber-marketing/drovr-unsubscribe-page'),
		import('@/lib/subscriber-marketing/drovr-purchase-resolve'),
		import('@/lib/subscriber-marketing/survey-interest-facts-live'),
	])
	const baseUrl = resolveDrovrApiBaseUrl({
		DROVR_API_BASE_URL: process.env.DROVR_API_BASE_URL,
		DROVR_SHADOW_INGEST_URL: process.env.DROVR_SHADOW_INGEST_URL,
	})
	const apiKey = drovrApiKeyForTenant('org-aihero')
	const config = baseUrl && apiKey ? { baseUrl, apiKey } : undefined
	return {
		findContactIdForEmail: (email) => store.findContactIdForEmail(db, email),
		writeLocalInterestFact: (args) => store.writeLocalInterestFact(db, args),
		drovr: config && {
			resolve: async (email) =>
				(await resolveDrovrContacts({ emails: [email], config })).get(
					normalizeResolveEmail(email),
				),
			record: (fact) =>
				recordInterestFacts({ facts: [fact], config, firstWins: true }),
		},
	}
}

async function pendingStore() {
	const { redis } = await import('@/server/redis-client')
	return redis as unknown as PendingInterestStore
}

/**
 * The pending row is a convenience, never a gate: this run holds the join
 * whatever Redis says, so a Redis failure is a log line and the join goes on
 * with its own time.
 */
async function holdPendingJoin(data: InterestFactRequested['data']) {
	const { holdPendingInterestFact } =
		await import('@/lib/cta/interest-fact-pending')
	// recordInterestFact refuses these; there is nothing to hold.
	if (
		!isInterestFieldKey(data.fieldKey) ||
		!Number.isFinite(Date.parse(data.expressedAt))
	) {
		return data.expressedAt
	}
	try {
		return (
			await holdPendingInterestFact(await pendingStore(), {
				email: data.email,
				fieldKey: data.fieldKey,
				at: data.expressedAt,
			})
		).firstAt
	} catch (error) {
		const { log } = await import('@/server/logger')
		await log.warn('interest.fact.pending.hold_failed', {
			fieldKey: data.fieldKey,
			error: error instanceof Error ? error.name : 'unknown',
		})
		return data.expressedAt
	}
}

async function releasePendingJoin(data: InterestFactRequested['data']) {
	const { releasePendingInterestFact } =
		await import('@/lib/cta/interest-fact-pending')
	try {
		await releasePendingInterestFact(await pendingStore(), data)
	} catch (error) {
		// The row's TTL clears it.
		const { log } = await import('@/server/logger')
		await log.warn('interest.fact.pending.release_failed', {
			fieldKey: data.fieldKey,
			error: error instanceof Error ? error.name : 'unknown',
		})
	}
}

/**
 * Records one waitlist or interest join locally and in drovr. Kit is never
 * read or written here. A join from someone the site does not know yet (a
 * new address still confirming its double opt-in) is held, and the run keeps
 * looking on a backoff until the person is known, then records the join at
 * its first time. At the end of the 7-day confirm window it stops and logs
 * `wait: expired`.
 */
export const interestFactRecord = inngest.createFunction(
	{
		id: 'interest-fact-record',
		name: 'Record a waitlist or interest join',
		retries: 5,
		idempotency: 'event.data.email + ":" + event.data.fieldKey',
		throttle: { limit: 10, period: '1s' },
	},
	{ event: INTEREST_FACT_REQUESTED_EVENT },
	async ({ event, step }) => {
		const data = event.data as InterestFactRequested['data']
		const { log } = await import('@/server/logger')
		if (data.survey) {
			const survey = data.survey
			// A drovr failure throws inside the step, so Inngest retries it.
			const outcome = await step.run('record-survey-goal-fact', async () => {
				const [
					{ drovrApiKeyForTenant },
					{ resolveDrovrApiBaseUrl },
					{ recordGoalInterestFact },
				] = await Promise.all([
					import('@/lib/subscriber-marketing/drovr-shadow-emitter'),
					import('@/lib/subscriber-marketing/drovr-unsubscribe-page'),
					import('@/lib/subscriber-marketing/survey-interest-facts-live'),
				])
				const baseUrl = resolveDrovrApiBaseUrl({
					DROVR_API_BASE_URL: process.env.DROVR_API_BASE_URL,
					DROVR_SHADOW_INGEST_URL: process.env.DROVR_SHADOW_INGEST_URL,
				})
				const apiKey = drovrApiKeyForTenant('org-aihero')
				if (!baseUrl || !apiKey) return 'not-configured' as const
				return recordGoalInterestFact({
					row: {
						id: survey.rowId,
						questionId: survey.questionId,
						answer: survey.answer,
						createdAt: new Date(data.expressedAt),
						email: data.email,
					},
					config: { baseUrl, apiKey },
				})
			})
			await step.run('log-survey-goal-fact', () =>
				log.info('survey.interest_fact.recorded', {
					rowId: survey.rowId,
					outcome,
				}),
			)
			return { survey: outcome }
		}
		// Held before the first look, so a second run for this person and list
		// (a join after Inngest's 24-hour idempotency) records the first time.
		const firstAt = await step.run('hold-pending-join', () =>
			holdPendingJoin(data),
		)
		const run = (id: string) =>
			step.run(id, async () =>
				recordInterestFact(await liveDeps(), { ...data, expressedAt: firstAt }),
			)

		const outcome = await waitForInterestContact({
			// Arrival, not expressedAt: a backfill carries Kit's older date.
			receivedAt: event.ts ?? Date.parse(data.expressedAt),
			first: await run('record-interest-fact'),
			sleepUntil: (id, at) => step.sleepUntil(id, at),
			check: run,
		})
		const { result } = outcome

		await step.run('release-pending-join', () => releasePendingJoin(data))
		await step.run('log-interest-fact', () =>
			log.info('interest.fact.recorded', {
				fieldKey: data.fieldKey,
				via: data.via,
				local: result.local,
				drovr: result.drovr,
				wait: outcome.wait,
				checks: outcome.checks,
			}),
		)
		// The output keeps today's { local, drovr } shape for anything reading runs.
		return { ...result, wait: outcome.wait, checks: outcome.checks }
	},
)
