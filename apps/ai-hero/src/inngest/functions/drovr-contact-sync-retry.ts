import { CONTACT_SYNC_RETRY_EVENT } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import { DROVR_SEND_RETRIES } from '@/lib/subscriber-marketing/drovr-outbox'
import { runOwnedStragglerRetry } from '@/lib/subscriber-marketing/contact-sync-straggler-owner'
import { createStragglerOwnerStore } from '@/lib/subscriber-marketing/contact-sync-straggler-owner-mysql'
import {
	deliverHoldingUnsubscribed,
	isUnsubscribedForHold,
} from '@/lib/subscriber-marketing/drovr-straggler-hold'
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
		retries: DROVR_SEND_RETRIES,
		concurrency: [{ limit: 4 }],
	},
	{ event: CONTACT_SYNC_RETRY_EVENT },
	async ({ event, step, attempt, maxAttempts, runId }) => {
		const [
			{ db, acquireDatabaseConnection },
			{ env },
			{ log, withLogContext },
			{ deliverBatchOrThrow },
			{ drovrApiKeyForTenant, DROVR_AUTHORITY_TENANT_ID },
			{ DrizzleCaptureMarketingRepository },
			{ findContactKitIdentity },
			{ createDrizzleContactProfileVersionStore },
			{ contactSyncSendOrOutbox, settleOrHoldStragglerStops },
			{ readContactSendStanding },
		] = await Promise.all([
			import('@/db'),
			import('@/env.mjs'),
			import('@/server/logger'),
			import('@/lib/subscriber-marketing/drovr-shadow-delivery'),
			import('@/lib/subscriber-marketing/drovr-shadow-emitter'),
			import('@/lib/subscriber-marketing/drizzle-capture-repository'),
			import('@/lib/subscriber-marketing/contact-kit-identity-drizzle'),
			import('@/lib/subscriber-marketing/contact-profile-version-drizzle'),
			import('@/lib/subscriber-marketing/drovr-outbox-contact-sync'),
			import('@/lib/subscriber-marketing/drovr-personalize'),
		])
		// Row 204: the last failed attempt outboxes the events.
		const outboxing = contactSyncSendOrOutbox({ attempt, maxAttempts })
		const drovrConfig = () => {
			const ingestUrl = env.DROVR_SHADOW_INGEST_URL
			const apiKey = drovrApiKeyForTenant(DROVR_AUTHORITY_TENANT_ID)
			// Never drop: an unconfigured drovr is a retry, not an answer.
			if (!ingestUrl || !apiKey)
				throw new Error('drovr is not configured for the contact sync retry')
			return { ingestUrl, apiKey }
		}
		const repository = new DrizzleCaptureMarketingRepository(db)
		const retryArgs: Parameters<typeof runContactSyncStragglerRetry>[0] = {
			event,
			step,
			env: process.env,
			now: () => Date.now(),
			warn: log.warn,
			// Row 204c: a stop a backfill outboxed while it waited is settled
			// when this send lands it, or held if drovr refused it.
			deliver: deliverHoldingUnsubscribed({
				warn: log.warn,
				isUnsubscribed: (contactId) =>
					isUnsubscribedForHold(readContactSendStanding, repository, contactId),
				send: (events) =>
					outboxing(events, async () =>
						settleOrHoldStragglerStops(
							events,
							await deliverBatchOrThrow({
								events,
								config: drovrConfig(),
								deferNotLive: true,
								caller: 'straggler-retry',
								// Contact-directory events only: nothing is clamped (row
								// 201g), so any instant posts the same bytes.
								clampAt: Date.now(),
							}),
						),
					),
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
					outboxing(births, () =>
						deliverBatchOrThrow({
							events: births,
							config: drovrConfig(),
							// Directory births are never clamped (row 201g).
							clampAt: Date.now(),
							caller: 'directory-birth',
						}),
					),
			}),
		}
		return Object.hasOwn(event.data, 'stragglerOwner')
			? runOwnedStragglerRetry({
					...retryArgs,
					runId,
					run: runContactSyncStragglerRetry,
					store: createStragglerOwnerStore(acquireDatabaseConnection),
					parked: (fields) =>
						withLogContext({}, () => log.warn('aih.drovr_sync.parked', fields)),
					// Different sets are gap-CANDIDATE upper bounds, never exact new-key counts.
					joined: (counts) =>
						withLogContext({}, () =>
							log.info('aih.drovr_sync.joined_membership_candidate', counts),
						),
				})
			: runContactSyncStragglerRetry(retryArgs)
	},
)
