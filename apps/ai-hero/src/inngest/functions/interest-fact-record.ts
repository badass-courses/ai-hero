import {
	INTEREST_FACT_REQUESTED_EVENT,
	type InterestFactRequested,
} from '@/inngest/events/interest-fact'
import { inngest } from '@/inngest/inngest.server'
import {
	recordInterestFact,
	shouldWaitForContact,
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

/**
 * Records one waitlist or interest join locally and in drovr. Kit is never
 * read or written here. A join from someone the site does not know yet (a
 * new address still confirming) waits once for the signup to land, then
 * records what it can and says what it could not.
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
		const run = (id: string) =>
			step.run(id, async () => recordInterestFact(await liveDeps(), data))

		let result = await run('record-interest-fact')
		if (shouldWaitForContact(result)) {
			await step.sleep('wait-for-signup', '15m')
			result = await run('record-interest-fact-after-wait')
		}

		await step.run('log-interest-fact', () =>
			log.info('interest.fact.recorded', {
				fieldKey: data.fieldKey,
				via: data.via,
				local: result.local,
				drovr: result.drovr,
			}),
		)
		return result
	},
)
