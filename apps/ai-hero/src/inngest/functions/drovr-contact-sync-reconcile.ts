import { inngest } from '@/inngest/inngest.server'
import type { GetStepTools } from 'inngest'
import {
	reconcileSyncOutcome,
	runContactSyncReconcile,
	type ContactSyncReconcilePorts,
	type ContactSyncReconcileReceipt,
	type ScannedContactEvent,
} from '@/lib/subscriber-marketing/contact-sync-reconcile'
import {
	parseDrovrProfileSyncConfig,
	type ContactProfileSyncReceipt,
} from '@/lib/subscriber-marketing/drovr-contact-profile-sync'
import type { DrovrShadowEvent } from '@/lib/subscriber-marketing/drovr-shadow-emitter'

import { drovrContactProfileSync } from './drovr-contact-profile-sync'
import {
	drovrEventsDeliver,
	type DrovrEventsDeliverReceipt,
} from './drovr-events-deliver'

type ReconcileStep = Pick<GetStepTools<typeof inngest>, 'run' | 'invoke'>

/**
 * One reconcile run as Inngest steps: every read memoized, every contact's
 * sync invoked (so it queues behind any other sync of the same contact and
 * answers only once drovr took it), the stop re-send invoked on the live
 * delivery function, then the heartbeat, then the watermark.
 */
export async function reconcileContactSync(args: {
	step: ReconcileStep
	env: Readonly<Record<string, string | undefined>>
	configured: boolean
	error: (event: string, fields: Record<string, unknown>) => unknown
	store: Pick<
		ContactSyncReconcilePorts,
		'readWatermark' | 'scanChanges' | 'rotatedContacts'
	> & { writeWatermark(watermark: string, heartbeatAt: string): Promise<void> }
	stopFacts: (stops: ScannedContactEvent[]) => Promise<DrovrShadowEvent[]>
	heartbeat: (syncedThrough: string) => Promise<unknown>
	/** From a memoized step, so every replay reads the same start. */
	startedAt: string
}): Promise<
	ContactSyncReconcileReceipt | { status: 'skipped'; reason: string }
> {
	const config = parseDrovrProfileSyncConfig(args.env)
	if (!config.enabled) return { status: 'skipped', reason: config.reason }
	if (!args.configured) {
		await args.error('drovr.contact_sync.not_configured', {
			missing: 'DROVR_SHADOW_INGEST_URL or DROVR_API_KEY_ORG_AIHERO',
		})
		return { status: 'skipped', reason: 'drovr-not-configured' }
	}
	const { step, store } = args
	return runContactSyncReconcile({
		now: () => new Date(args.startedAt),
		readWatermark: async () =>
			(await step.run('read-watermark', () => store.readWatermark())) as
				string | undefined,
		scanChanges: async (window) =>
			(await step.run(`scan-${window.scope}`, () =>
				store.scanChanges(window),
			)) as ScannedContactEvent[],
		rotatedContacts: async (window) =>
			(await step.run('rotated-contacts', () =>
				store.rotatedContacts(window),
			)) as { contactId: string; at: string }[],
		syncContact: async (contactId) =>
			reconcileSyncOutcome(
				contactId,
				(await step.invoke(`sync:${contactId}`, {
					function: drovrContactProfileSync,
					data: { contactId, reason: 'reconcile' },
				})) as ContactProfileSyncReceipt,
			),
		resendStops: async (stops) => {
			const events = (await step.run('load-stops', () =>
				args.stopFacts(stops),
			)) as DrovrShadowEvent[]
			if (events.length === 0) return
			const receipt = (await step.invoke('resend-stops', {
				function: drovrEventsDeliver,
				data: { events, source: 'contact-event' },
			})) as DrovrEventsDeliverReceipt
			if (receipt.status !== 'delivered') {
				throw new Error(`stop re-send was not delivered: ${receipt.reason}`)
			}
			if (receipt.rejected > 0) {
				throw new Error(
					`stop re-send was not delivered: drovr rejected ${receipt.rejected}`,
				)
			}
		},
		heartbeat: async (syncedThrough) => {
			await step.run('heartbeat', () => args.heartbeat(syncedThrough))
		},
		writeWatermark: async (watermark) => {
			await step.run('write-watermark', () =>
				store.writeWatermark(watermark, new Date().toISOString()),
			)
		},
	})
}

export const drovrContactSyncReconcile = inngest.createFunction(
	{
		id: 'drovr-contact-sync-reconcile-v1',
		name: 'drovr: contact sync reconcile and heartbeat',
		retries: 3,
		// One run at a time: the watermark only moves forward anyway, but two
		// overlapping runs would sync the same contacts twice.
		concurrency: [{ limit: 1 }],
	},
	{ cron: '*/15 * * * *' },
	async ({ step }) => {
		const startedAt = (await step.run('started-at', async () =>
			new Date().toISOString(),
		)) as string
		const [
			{ db },
			{ env },
			{ log },
			{ DrizzleCaptureMarketingRepository },
			{ createDrizzleContactSyncStore },
			{ stopFactsFor },
			{ postContactSyncHeartbeat },
			{ drovrApiKeyForTenant, DROVR_AUTHORITY_TENANT_ID },
		] = await Promise.all([
			import('@/db'),
			import('@/env.mjs'),
			import('@/server/logger'),
			import('@/lib/subscriber-marketing/drizzle-capture-repository'),
			import('@/lib/subscriber-marketing/contact-sync-reconcile-drizzle'),
			import('@/lib/subscriber-marketing/contact-sync-reconcile'),
			import('@/lib/subscriber-marketing/contact-sync-heartbeat'),
			import('@/lib/subscriber-marketing/drovr-shadow-emitter'),
		])
		const ingestUrl = env.DROVR_SHADOW_INGEST_URL
		const apiKey = drovrApiKeyForTenant(DROVR_AUTHORITY_TENANT_ID)
		const repository = new DrizzleCaptureMarketingRepository(db)
		return reconcileContactSync({
			step,
			env: process.env,
			configured: Boolean(ingestUrl && apiKey),
			error: log.error,
			store: createDrizzleContactSyncStore(db),
			stopFacts: (stops) => stopFactsFor(repository, stops),
			heartbeat: (syncedThrough) =>
				postContactSyncHeartbeat({
					config: { ingestUrl: ingestUrl!, apiKey: apiKey! },
					syncedThrough,
				}),
			startedAt,
		})
	},
)
