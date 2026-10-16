import { DROVR_OUTBOX_REPLAY_REQUESTED_EVENT } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import { queueCappedReplay } from '@/lib/subscriber-marketing/contact-sync-replay-queue'
import { readUnsubscribedValuePathContactIds } from '@/lib/subscriber-marketing/drovr-value-path-birth-admission-live'

/**
 * Row 204: re-posts what the drovr outbox holds for this deployment's
 * target, by each row's drovr idempotency key, until drovr answers 2xx.
 * Every five minutes at :02, clear of the :00/:30 bulk pages, the :15
 * contact-sync reconcile and the :40 birth guard. One run at a time and no
 * function retries: the next tick is the retry. Every run logs
 * `drovr.outbox.depth`; `drovr.outbox.alert` is the line the Axiom monitor
 * watches (pending > 25, oldest > 60 min, anything held or rejected).
 *
 * AIH_DROVR_OUTBOX_REPLAY_DISABLED=true stops the replay; the capture
 * carries on filling the outbox.
 */
export const drovrOutboxReplay = inngest.createFunction(
	{
		id: 'drovr-outbox-replay-v1',
		name: 'drovr: replay the outbox',
		retries: 0,
		concurrency: [{ limit: 1 }],
	},
	[{ cron: '2-57/5 * * * *' }, { event: DROVR_OUTBOX_REPLAY_REQUESTED_EVENT }],
	async ({ step }) => {
		const [
			{ db },
			{ env },
			{ log },
			{ runDrovrOutboxReplay, DrovrOutboxUnavailableError },
			{ createDrizzleDrovrOutboxStore },
			{ drovrOutboxTargetFromEnv },
			{ postDrovrOutboxRow },
			{
				deliverDrovrShadowEvent,
				drovrApiKeyForTenant,
				DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
			},
			{ isNeverBornOwnerStop },
			{ fanOutOwnedEvents, isShadowNewsletterBirth },
			{ resolveOwnedContactIds },
			{ parseDrovrSignupDeliveryConfig, postDrovrSignup },
		] = await Promise.all([
			import('@/db'),
			import('@/env.mjs'),
			import('@/server/logger'),
			import('@/lib/subscriber-marketing/drovr-outbox'),
			import('@/lib/subscriber-marketing/drovr-outbox-drizzle'),
			import('@/lib/subscriber-marketing/drovr-outbox-live'),
			import('@/lib/subscriber-marketing/drovr-outbox-replay-post'),
			import('@/lib/subscriber-marketing/drovr-shadow-emitter'),
			import('@/lib/subscriber-marketing/drovr-shadow-delivery'),
			import('@/lib/subscriber-marketing/drovr-ownership'),
			import('@/lib/subscriber-marketing/drovr-ownership-live'),
			import('@/lib/subscriber-marketing/drovr-doi-signup'),
		])
		if (
			['true', '1'].includes(
				String(process.env.AIH_DROVR_OUTBOX_REPLAY_DISABLED ?? '')
					.trim()
					.toLowerCase(),
			)
		)
			return { status: 'skipped', reason: 'replay disabled' }
		const target = drovrOutboxTargetFromEnv()
		const ingestUrl = env.DROVR_SHADOW_INGEST_URL
		if (!target || !ingestUrl) {
			await log.warn('drovr.outbox.replay_not_configured', {
				missing: 'DROVR_SHADOW_INGEST_URL',
			})
			return { status: 'skipped', reason: 'drovr-not-configured' }
		}
		const signupConfig = parseDrovrSignupDeliveryConfig(env)
		return step.run('replay', async () => {
			try {
				const store = createDrizzleDrovrOutboxStore(db)
				return await runDrovrOutboxReplay({
					store,
					target,
					now: () => new Date(),
					log,
					post: async (row) => {
						const at = Date.now()
						let publishContinuation: (() => Promise<unknown>) | undefined
						if ('heldBatch' in row || row.heldBatchBlocked) {
							const [{ prepareHeldBatchReplay }, { heldBatchPersistenceLive, heldBatchRowsLive }, { HeldBatchContinuationError }, { routeContactSyncRetry }] = await Promise.all([
								import('@/lib/subscriber-marketing/contact-sync-held-batch-replay'), import('@/lib/subscriber-marketing/contact-sync-held-batch-drizzle'), import('@/lib/subscriber-marketing/contact-sync-held-batch'), import('@/lib/subscriber-marketing/contact-sync-retry-route'),
							])
							try {
								const persistence = await heldBatchPersistenceLive()
								const plan = await prepareHeldBatchReplay(row, { block: (anchor, reason, expected) => persistence.block(anchor, reason, expected), rows: heldBatchRowsLive })
								if (!plan || plan.kind === 'held') return { kind: 'held', detail: new HeldBatchContinuationError({ reason: plan?.reason ?? 'the continuation cannot be reconstructed' }).message }
								publishContinuation = () => inngest.send(routeContactSyncRetry({ ...plan.request, ts: at }))
							} catch (error) {
								const detail = error instanceof HeldBatchContinuationError ? error.message : new HeldBatchContinuationError({ reason: 'strict replay reconstruction is unavailable; retained work was not published' }).message
								try { await log.warn('drovr.outbox.held_batch_invalid', { id: row.id, detail }) } catch { /* logging failure must not reopen a held anchor */ }
								return { kind: 'held', detail }
							}
						}
						const queued = await queueCappedReplay(row, event => inngest.send(event), at, (until, expectedUntil, publicationId) => store.leaseQueue({ target, id: row.id, nextAttemptAt: until, ...(expectedUntil ? { expectedUntil } : { dueAt: new Date(at).toISOString() }), publicationId }), publicationId => store.abortQueueHandoff({ target: row.target, id: row.id, publicationId }), publishContinuation)
						if (queued) return queued
						return postDrovrOutboxRow(row, {
							ingestUrl,
							readBirthOptOuts: (ids) =>
								readUnsubscribedValuePathContactIds(ids, db),
							info: log.info,
							apiKeyFor: (tenantId) =>
								drovrApiKeyForTenant(
									tenantId as Parameters<typeof drovrApiKeyForTenant>[0],
								),
							deliver: deliverDrovrShadowEvent,
							isNeverBornOwnerStop,
							fanOut: async (events) => {
								const owned = await resolveOwnedContactIds(events)
								const births = events.filter(isShadowNewsletterBirth)
								const newsletterOwned = births.length
									? await resolveOwnedContactIds(births, {
											journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
										})
									: []
								return fanOutOwnedEvents(
									events,
									new Set(owned),
									new Set(newsletterOwned),
								)
							},
							...(signupConfig
								? {
										signup: {
											post: (request) => postDrovrSignup(request, signupConfig),
										},
									}
								: {}),
						})
					},
				})
			} catch (error) {
				// Before the deploy request lands there is no table: nothing to
				// replay, and nothing was captured either.
				if (error instanceof DrovrOutboxUnavailableError) {
					await log.info('drovr.outbox.unavailable', {
						lane: 'replay',
						error: error.message,
					})
					return { status: 'skipped' as const, reason: 'no outbox table' }
				}
				throw error
			}
		})
	},
)
