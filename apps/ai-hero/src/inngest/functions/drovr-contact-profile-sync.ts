import { DROVR_CONTACT_PROFILE_SYNC_EVENT } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import { DROVR_SEND_RETRIES } from '@/lib/subscriber-marketing/drovr-outbox'
import { runContactProfileSync } from '@/lib/subscriber-marketing/drovr-contact-profile-sync'

export const drovrContactProfileSync = inngest.createFunction(
	{
		id: 'drovr-contact-profile-sync-v1',
		name: 'drovr: sync one contact profile',
		retries: DROVR_SEND_RETRIES,
		concurrency: [{ key: 'event.data.contactId', limit: 1 }],
	},
	{ event: DROVR_CONTACT_PROFILE_SYNC_EVENT },
	async ({ event, step, attempt, maxAttempts }) => {
		const [
			{ db },
			{ env },
			{ log },
			{ DrizzleCaptureMarketingRepository },
			{ createDrizzleValuePathLinkAnchorStore },
			{ createDrizzleContactProfileVersionStore },
			{ findContactKitIdentity },
			{ readContactProfileSnapshot },
			{ getValuePathAnswerPages },
			{ deliverBatchOrThrow },
			{
				drovrApiKeyForTenant,
				DROVR_AUTHORITY_TENANT_ID,
				DROVR_SKILLS_COURSE_JOURNEY_ID,
			},
			{ findJourneyOwnerAssignment, isOnDrovrSendingJourney },
			{ SKILLS_WORKFLOW_VALUE_PATH },
			{ createDirectoryBirth },
			{ contactSyncSendOrOutbox },
		] = await Promise.all([
			import('@/db'),
			import('@/env.mjs'),
			import('@/server/logger'),
			import('@/lib/subscriber-marketing/drizzle-capture-repository'),
			import('@/lib/subscriber-marketing/drizzle-value-path-link-anchor'),
			import('@/lib/subscriber-marketing/contact-profile-version-drizzle'),
			import('@/lib/subscriber-marketing/contact-kit-identity-drizzle'),
			import('@/lib/subscriber-marketing/drovr-contact-profile-sync'),
			import('@/lib/subscriber-marketing/value-path-answer-page'),
			import('@/lib/subscriber-marketing/drovr-shadow-delivery'),
			import('@/lib/subscriber-marketing/drovr-shadow-emitter'),
			import('@/lib/subscriber-marketing/drovr-ownership'),
			import('@/lib/subscriber-marketing/skills-newsletter-path-entry'),
			import('@/lib/subscriber-marketing/contact-sync-straggler-retry'),
			import('@/lib/subscriber-marketing/drovr-outbox-contact-sync'),
		])
		// Row 204: the last failed attempt outboxes the events.
		const outboxing = contactSyncSendOrOutbox({ attempt, maxAttempts })
		const repository = new DrizzleCaptureMarketingRepository(db)
		return runContactProfileSync({
			event,
			step,
			env: process.env,
			readSnapshot: async ({ contactId, valuePathSlug }) =>
				readContactProfileSnapshot({
					repository,
					contactId,
					kitIdentity: await findContactKitIdentity(db, contactId),
					valuePathSlug,
					answerPages: valuePathSlug ? await getValuePathAnswerPages() : [],
					baseUrl:
						env.NEXT_PUBLIC_URL ??
						env.NEXT_PUBLIC_SITE_URL ??
						'https://www.aihero.dev',
					pathTokenSecret: env.AI_HERO_VALUE_PATH_TOKEN_SECRET,
					linkAnchors: createDrizzleValuePathLinkAnchorStore(db),
					now: new Date().toISOString(),
					warn: log.warn,
				}),
			versionFor: (contactId, contentHash) =>
				createDrizzleContactProfileVersionStore(db).versionFor(
					contactId,
					contentHash,
				),
			acknowledge: (contactId, profileVersion) =>
				createDrizzleContactProfileVersionStore(db).acknowledge(
					contactId,
					profileVersion,
				),
			deliver: async (events) => {
				const ingestUrl = env.DROVR_SHADOW_INGEST_URL
				const apiKey = drovrApiKeyForTenant(DROVR_AUTHORITY_TENANT_ID)
				if (!ingestUrl || !apiKey) return 'not-configured'
				// One contact's events, well under drovr's 100 per batch.
				// Refusals come back deferred, for the straggler retry (§4).
				return outboxing(events, () =>
					deliverBatchOrThrow({
						events,
						config: { ingestUrl, apiKey },
						deferNotLive: true,
						// Contact-directory events only: nothing is clamped (row
						// 201g), so any instant posts the same bytes.
						clampAt: Date.now(),
					}),
				)
			},
			birth: createDirectoryBirth({
				findContactById: (id) => repository.findContactById(id),
				kitSubscriberIdFor: async (id) =>
					(await findContactKitIdentity(db, id)).kitSubscriberId,
				deliver: async (births) => {
					const ingestUrl = env.DROVR_SHADOW_INGEST_URL
					const apiKey = drovrApiKeyForTenant(DROVR_AUTHORITY_TENANT_ID)
					if (!ingestUrl || !apiKey)
						throw new Error('drovr is not configured for a directory birth')
					return outboxing(births, () =>
						deliverBatchOrThrow({
							events: births,
							config: { ingestUrl, apiKey },
							// Directory births are never clamped (row 201g).
							clampAt: Date.now(),
						}),
					)
				},
			}),
			onSendingJourney: (contactId) =>
				isOnDrovrSendingJourney(repository, contactId),
			ownedPath: async (contactId) =>
				(await findJourneyOwnerAssignment(
					repository,
					contactId,
					DROVR_SKILLS_COURSE_JOURNEY_ID,
				))
					? SKILLS_WORKFLOW_VALUE_PATH
					: undefined,
		})
	},
)
