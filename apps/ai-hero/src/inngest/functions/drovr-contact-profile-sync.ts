import { DROVR_CONTACT_PROFILE_SYNC_EVENT } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import { runContactProfileSync } from '@/lib/subscriber-marketing/drovr-contact-profile-sync'

export const drovrContactProfileSync = inngest.createFunction(
	{
		id: 'drovr-contact-profile-sync-v1',
		name: 'drovr: sync one contact profile',
		retries: 6,
		concurrency: [{ key: 'event.data.contactId', limit: 1 }],
	},
	{ event: DROVR_CONTACT_PROFILE_SYNC_EVENT },
	async ({ event, step }) => {
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
			{ findJourneyOwnerAssignment },
			{ SKILLS_WORKFLOW_VALUE_PATH },
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
		])
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
			deliver: async (events) => {
				const ingestUrl = env.DROVR_SHADOW_INGEST_URL
				const apiKey = drovrApiKeyForTenant(DROVR_AUTHORITY_TENANT_ID)
				if (!ingestUrl || !apiKey) return 'not-configured'
				// One contact's events, well under drovr's 100 per batch.
				return deliverBatchOrThrow({ events, config: { ingestUrl, apiKey } })
			},
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
