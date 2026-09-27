import { inngest } from '@/inngest/inngest.server'

/**
 * Hawk row 110: every value-path owner gets born. Hourly at :40 (clear of
 * the :15 reconcile and the :00/:30 bulk runs), one run at a time. See
 * owner-birth-guard.ts for what it reads and when it re-posts.
 */
export const drovrOwnerBirthGuard = inngest.createFunction(
	{
		id: 'drovr-owner-birth-guard-v1',
		name: 'drovr: re-post a value-path owner birth that never landed',
		retries: 3,
		concurrency: [{ limit: 1 }],
	},
	{ cron: '40 * * * *' },
	async ({ step }) => {
		const startedAtMs = (await step.run('started-at', async () =>
			Date.now(),
		)) as number
		const [
			{ db },
			{ env },
			{ log },
			{ DrizzleCaptureMarketingRepository },
			{ createDrizzleOwnerBirthGuardStore, ownerBirthRepostMarker },
			{ runOwnerBirthGuard },
			{ readDrovrEmailDelivery },
			{ readDrovrContactActor },
			{ deliverOrThrow },
			{ drovrApiKeyForTenant, DROVR_AUTHORITY_TENANT_ID },
			{ resolveDrovrApiBaseUrl },
			{ SKILLS_WORKFLOW_EMAIL_ZERO },
		] = await Promise.all([
			import('@/db'),
			import('@/env.mjs'),
			import('@/server/logger'),
			import('@/lib/subscriber-marketing/drizzle-capture-repository'),
			import('@/lib/subscriber-marketing/owner-birth-guard-drizzle'),
			import('@/lib/subscriber-marketing/owner-birth-guard'),
			import('@/lib/subscriber-marketing/drovr-email-delivery'),
			import('@/lib/subscriber-marketing/drovr-contact-actor'),
			import('@/lib/subscriber-marketing/drovr-shadow-delivery'),
			import('@/lib/subscriber-marketing/drovr-shadow-emitter'),
			import('@/lib/subscriber-marketing/drovr-unsubscribe-page'),
			import('@/lib/subscriber-marketing/skills-newsletter-path-entry'),
		])
		const ingestUrl = env.DROVR_SHADOW_INGEST_URL
		const apiKey = drovrApiKeyForTenant(DROVR_AUTHORITY_TENANT_ID)
		const baseUrl = resolveDrovrApiBaseUrl({
			DROVR_API_BASE_URL: process.env.DROVR_API_BASE_URL,
			DROVR_SHADOW_INGEST_URL: ingestUrl,
		})
		if (!ingestUrl || !apiKey || !baseUrl) {
			await log.error('drovr.owner_birth_guard.not_configured', {
				missing: 'DROVR_SHADOW_INGEST_URL or DROVR_API_KEY_ORG_AIHERO',
			})
			return { status: 'skipped', reason: 'drovr-not-configured' }
		}
		const repository = new DrizzleCaptureMarketingRepository(db)
		const readConfig = { baseUrl, apiKey }
		return runOwnerBirthGuard({
			step,
			startedAtMs,
			ports: {
				...createDrizzleOwnerBirthGuardStore(db),
				readDelivery: (contactId) =>
					readDrovrEmailDelivery({
						contactId,
						email: SKILLS_WORKFLOW_EMAIL_ZERO,
						config: readConfig,
					}),
				readActor: (contactId, journeyId) =>
					readDrovrContactActor({ contactId, journeyId, config: readConfig }),
				post: (event) =>
					deliverOrThrow({ event, config: { ingestUrl, apiKey } }),
				recordRepost: async (owner, outcome) => {
					await repository.createContactEvent(
						ownerBirthRepostMarker(owner, outcome, new Date().toISOString()),
					)
				},
				log: { info: log.info, warn: log.warn },
			},
		})
	},
)
