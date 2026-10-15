import { CONTACT_SYNC_RETRY_EVENT, deliverEventNameFor } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import { DROVR_SEND_RETRIES } from '@/lib/subscriber-marketing/drovr-outbox'
import { runPacedSend, waitForBulkSlot } from '@/lib/subscriber-marketing/drovr-bulk-pace'
import { createDirectoryBirth, runContactSyncStragglerRetry } from '@/lib/subscriber-marketing/contact-sync-straggler-retry'
import { profileVersionForRefresh } from '@/lib/subscriber-marketing/contact-sync-offer-refresh'
import type { DrovrShadowEvent } from '@/lib/subscriber-marketing/drovr-shadow-emitter'

/** Refused events keep their bytes/key forever: first retry after an hour,
 * then every two hours. Transient HTTP attempts reserve fresh durable slots.
 */
export const drovrContactSyncRetry = inngest.createFunction(
	{ id: 'drovr-contact-sync-retry-v1', name: 'drovr: retry refused contact sync events', retries: DROVR_SEND_RETRIES, concurrency: [{ limit: 4 }] },
	{ event: CONTACT_SYNC_RETRY_EVENT },
	async ({ event, step, attempt, maxAttempts }) => {
		const [{ db }, { env }, { log }, { deliverBatchOrThrow }, { drovrApiKeyForTenant, DROVR_AUTHORITY_TENANT_ID }, { DrizzleCaptureMarketingRepository }, { findContactKitIdentity }, { createDrizzleContactProfileVersionStore }, { contactSyncSendOrOutbox, settleOrHoldStragglerStops }, { settleDrovrOutboxLive }, { outboxEntryForEvent }] = await Promise.all([
			import('@/db'), import('@/env.mjs'), import('@/server/logger'), import('@/lib/subscriber-marketing/drovr-shadow-delivery'), import('@/lib/subscriber-marketing/drovr-shadow-emitter'), import('@/lib/subscriber-marketing/drizzle-capture-repository'), import('@/lib/subscriber-marketing/contact-kit-identity-drizzle'), import('@/lib/subscriber-marketing/contact-profile-version-drizzle'), import('@/lib/subscriber-marketing/drovr-outbox-contact-sync'), import('@/lib/subscriber-marketing/drovr-outbox-live'), import('@/lib/subscriber-marketing/drovr-outbox'),
		])
		// New bump requests always carry a class. A genuine offer-only repair
		// has neither a class nor a profile acknowledgement and stays live.
		const uncappedOffer = !event.data.paceClass && !event.data.acknowledge && event.data.items.every(item => item.event.type === 'contact.offer.issued')
		const kind = event.data.paceClass ?? 'delta'
		const source = kind === 'delta' ? 'contact-profile-sync' : kind === 'restate' ? 'contact-profile-restate' : kind === 'ingest' ? 'kit-directory-ingest' : 'contact-sync-backfill'
		const config = () => {
			const ingestUrl = env.DROVR_SHADOW_INGEST_URL
			const apiKey = drovrApiKeyForTenant(DROVR_AUTHORITY_TENANT_ID)
			if (!ingestUrl || !apiKey) throw new Error('drovr is not configured for the contact sync retry')
			return { ingestUrl, apiKey }
		}
		const deliver = (events: DrovrShadowEvent[], index = attempt) => contactSyncSendOrOutbox({ attempt: index, maxAttempts })(events, async () => {
			const answer = await settleOrHoldStragglerStops(events, await deliverBatchOrThrow({ events, config: config(), deferNotLive: true, clampAt: Date.now() }))
			if (answer.accepted > 0 && !answer.deferred?.length && !answer.rejected) await settleDrovrOutboxLive(events.map(item => outboxEntryForEvent(item, 'contactSync')), 'delivered by straggler')
			return answer
		})
		const repository = new DrizzleCaptureMarketingRepository(db)
		const birth = (ids: string[], index = attempt) => createDirectoryBirth({
			findContactById: id => repository.findContactById(id),
			kitSubscriberIdFor: async id => (await findContactKitIdentity(db, id)).kitSubscriberId,
			deliver: births => contactSyncSendOrOutbox({ attempt: index, maxAttempts })(births, () => deliverBatchOrThrow({ events: births, config: config(), clampAt: Date.now() })),
		})(ids)
		const pace = (id: string) => waitForBulkSlot(step, id, kind)
		return runContactSyncStragglerRetry({
			event, step, env: process.env, now: () => Date.now(), warn: log.warn, deliver, birth,
			...(uncappedOffer ? {} : {
				pacedDeliver: (id: string, events: DrovrShadowEvent[]) => runPacedSend(step, id, pace, index => deliver(events, index), attempt),
				pacedBirth: (id: string, ids: string[]) => runPacedSend(step, id, pace, index => birth(ids, index), attempt),
			}),
			afterProfile: async profile => {
				if (profile.idempotencyKey.includes(':restate:')) return
				await step.sendEvent(`refresh-offer:${profile.idempotencyKey}`, { id: `offer-refresh:${profile.idempotencyKey}`, name: deliverEventNameFor(source), data: { source, events: [], offerRefresh: { contactId: profile.contactId, profileVersion: profileVersionForRefresh(profile) } } })
			},
			acknowledge: (id, version) => createDrizzleContactProfileVersionStore(db).acknowledge(id, version),
		})
	},
)
