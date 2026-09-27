import { CONTACT_SYNC_RETRY_EVENT } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import {
	createDirectoryBirth,
	runContactSyncStragglerRetry,
} from '@/lib/subscriber-marketing/contact-sync-straggler-retry'

/**
 * Contact sync (contract §4): re-sends events drovr refused as
 * event-not-live or cold-start-unhandled, unchanged and under the same
 * keys, a day later (after drovr's straggler pass), and again each day
 * until drovr takes them. A transient failure retries with backoff.
 */
export const drovrContactSyncRetry = inngest.createFunction(
	{
		id: 'drovr-contact-sync-retry-v1',
		name: 'drovr: retry refused contact sync events',
		retries: 6,
		concurrency: [{ limit: 4 }],
	},
	{ event: CONTACT_SYNC_RETRY_EVENT },
	async ({ event, step }) => {
		const [
			{ db },
			{ env },
			{ log },
			{ deliverBatchOrThrow },
			{ drovrApiKeyForTenant, DROVR_AUTHORITY_TENANT_ID },
			{ DrizzleCaptureMarketingRepository },
			{ findContactKitIdentity },
			{ createDrizzleContactProfileVersionStore },
		] = await Promise.all([
			import('@/db'),
			import('@/env.mjs'),
			import('@/server/logger'),
			import('@/lib/subscriber-marketing/drovr-shadow-delivery'),
			import('@/lib/subscriber-marketing/drovr-shadow-emitter'),
			import('@/lib/subscriber-marketing/drizzle-capture-repository'),
			import('@/lib/subscriber-marketing/contact-kit-identity-drizzle'),
			import('@/lib/subscriber-marketing/contact-profile-version-drizzle'),
		])
		const drovrConfig = () => {
			const ingestUrl = env.DROVR_SHADOW_INGEST_URL
			const apiKey = drovrApiKeyForTenant(DROVR_AUTHORITY_TENANT_ID)
			// Never drop: an unconfigured drovr is a retry, not an answer.
			if (!ingestUrl || !apiKey)
				throw new Error('drovr is not configured for the contact sync retry')
			return { ingestUrl, apiKey }
		}
		const repository = new DrizzleCaptureMarketingRepository(db)
		return runContactSyncStragglerRetry({
			event,
			step,
			env: process.env,
			now: () => Date.now(),
			warn: log.warn,
			deliver: (events) =>
				deliverBatchOrThrow({
					events,
					config: drovrConfig(),
					deferNotLive: true,
				}),
			acknowledge: (contactId, profileVersion) =>
				createDrizzleContactProfileVersionStore(db).acknowledge(
					contactId,
					profileVersion,
				),
			birth: createDirectoryBirth({
				findContactById: (id) => repository.findContactById(id),
				kitSubscriberIdFor: async (id) =>
					(await findContactKitIdentity(db, id)).kitSubscriberId,
				deliver: (births) =>
					deliverBatchOrThrow({ events: births, config: drovrConfig() }),
			}),
		})
	},
)
