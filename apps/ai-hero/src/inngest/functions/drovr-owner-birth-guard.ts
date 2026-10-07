import { inngest } from '@/inngest/inngest.server'
import type { BirthFeedPreparation } from '@/lib/subscriber-marketing/drovr-birth-feed'
import { newsletterPauseDurationMs } from './newsletter-provider-pause'

/**
 * Hawk row 110: every value-path owner gets born. Hourly at :40 (clear of
 * the :15 reconcile and the :00/:30 bulk runs), one run at a time. See
 * owner-birth-guard.ts for what it reads and when it re-posts.
 */
export const OWNER_BIRTH_GUARD_MAX_COOLDOWN_MS = 50 * 60_000

export const drovrOwnerBirthGuard = inngest.createFunction(
	{
		id: 'drovr-owner-birth-guard-v1',
		name: 'drovr: re-post a value-path owner birth that never landed',
		retries: 3,
		concurrency: [{ limit: 1 }],
		// Drop overlapping hourly ticks, including during durable sleep.
		singleton: { mode: 'skip' },
		timeouts: { finish: '55m' },
	},
	{ cron: '40 * * * *' },
	async ({ step, runId }) => {
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
		// Freeze mode for the run: a flag change must not mix cached contact
		// and feed pages on retry. Absent/off leaves the deployed A path intact.
		const mode = await step.run('birth-feed-mode-v1', async () =>
			env.AIH_DROVR_BIRTH_FEED_ENABLED === 'true' ? 'feed' : 'contact',
		)
		let feed: BirthFeedPreparation | undefined
		if (mode === 'feed') {
			const [
				{ prepareBirthFeed, readDrovrBirths, BirthFeedFailure },
				{ createRedisBirthFeedStore },
				{ redis },
			] = await Promise.all([
				import('@/lib/subscriber-marketing/drovr-birth-feed'),
				import('@/lib/subscriber-marketing/drovr-birth-feed-store'),
				import('@/server/redis-client'),
			])
			try {
				feed = await prepareBirthFeed({
					step,
					startedAtMs,
					runId,
					store: createRedisBirthFeedStore({
						redis,
						tenantId: DROVR_AUTHORITY_TENANT_ID,
					}),
					read: (request) => readDrovrBirths({ request, config: readConfig }),
				})
			} catch (error) {
				await log.error('drovr.owner_birth_guard.feed_failed', {
					reason:
						error instanceof BirthFeedFailure
							? error.reason
							: 'feed-unavailable',
				})
				throw error
			}
		}
		const receipt =
			feed?.kind === 'shed'
				? {
						status: 'deferred' as const,
						reposted: 0,
						truncated: true,
						backpressure: feed.backpressure,
						birthFeedCalls: feed.calls,
					}
				: await runOwnerBirthGuard({
						step,
						startedAtMs,
						ports: {
							...createDrizzleOwnerBirthGuardStore(db),
							...(feed?.kind === 'ready' ? { birthFeed: feed.proof } : {}),
							readDelivery: (contactId, timeoutMs) =>
								readDrovrEmailDelivery({
									contactId,
									email: SKILLS_WORKFLOW_EMAIL_ZERO,
									timeoutMs,
									config: readConfig,
								}),
							readActor: (contactId, journeyId, timeoutMs) =>
								readDrovrContactActor({
									contactId,
									journeyId,
									timeoutMs,
									config: readConfig,
								}),
							// Row 201g: births clamp at the run's memoized start, so a retry of
							// a re-post's step posts the same bytes.
							post: (event) =>
								deliverOrThrow({
									event,
									config: { ingestUrl, apiKey },
									clampAt: startedAtMs,
								}),
							recordRepost: async (owner, outcome) => {
								await repository.createContactEvent(
									ownerBirthRepostMarker(
										owner,
										outcome,
										new Date().toISOString(),
									),
								)
							},
							log: { info: log.info, warn: log.warn },
						},
					})
		if (receipt?.backpressure) {
			// The scan has stopped, with zero reposts. Reuse the parser, but
			// bound this caller's cooldown below the cron period. Singleton skip
			// drops ticks during a long scan/sleep instead of queuing a burst.
			const cooldownMs = Math.min(
				OWNER_BIRTH_GUARD_MAX_COOLDOWN_MS,
				newsletterPauseDurationMs(receipt.backpressure.retryAfter, Date.now()),
			)
			await step.sleep('shed-read-cooldown', `${cooldownMs}ms`)
			return { ...receipt, cooldownMs }
		}
		return feed ? { ...receipt, birthFeedCalls: feed.calls } : receipt
	},
)
