import { inngest } from '@/inngest/inngest.server'
import {
	COUPON_BATCH_WAKE,
	couponBatchAlertsEnabled,
	couponBatchEnabled,
	couponBatchWorker,
} from '@/lib/coupon-batches/runtime'
import { log } from '@/server/logger'

export const couponBatchDrain = inngest.createFunction(
	{
		id: 'coupon-batch-drain',
		// Queue steps instead of skipping runs: a continuation is emitted while
		// this run is still active. The DB control row fences/paces every chunk.
		concurrency: { limit: 1 },
	},
	[{ event: COUPON_BATCH_WAKE }, { cron: '* * * * *' }],
	async ({ step }) => {
		if (!couponBatchEnabled()) return { state: 'disabled' }
		for (let i = 0; i < 40; i++) {
			const result = await step.run(`chunk-${i}`, () =>
				couponBatchWorker().runChunk(),
			)
			switch (result.state) {
				case 'paced':
					await step.sleep(`pace-${i}`, Math.max(1000, result.waitMs))
					break
				case 'worked':
					break
				case 'retry':
					await log.warn('coupon_batch.worker_retry', {
						reason: result.reason,
						attempts: result.attempts ?? null,
					})
					return result
				default:
					return result
			}
		}
		await step.sendEvent('wake-next-window', {
			name: COUPON_BATCH_WAKE,
			data: {},
		})
		return { state: 'continued' }
	},
)

export const couponBatchAlarms = inngest.createFunction(
	{
		id: 'coupon-batch-alarms',
		concurrency: { limit: 1 },
		singleton: { mode: 'skip' },
	},
	[{ event: COUPON_BATCH_WAKE }, { cron: '* * * * *' }],
	async ({ step }) => {
		if (!couponBatchAlertsEnabled()) return { state: 'disabled' }
		return step.run('deliver-coupon-batch-alerts', async () => {
			const attempted = await couponBatchWorker().drainAlerts(
				async (row) => {
					// A recipient must dedupe on Idempotency-Key before paging. An
					// unconfigured or failing pager leaves the durable outbox pending.
					const url = process.env.AIH_COUPON_BATCH_PAGE_URL
					const token = process.env.AIH_COUPON_BATCH_PAGE_TOKEN
					if (!url || !token || new URL(url).protocol !== 'https:')
						throw new Error('coupon_batch_pager_unavailable')
					const response = await fetch(url, {
						method: 'POST',
						redirect: 'error',
						signal: AbortSignal.timeout(4000),
						headers: {
							Authorization: `Bearer ${token}`,
							'Content-Type': 'application/json',
							'Idempotency-Key': row.id,
						},
						body: JSON.stringify({
							batchId: row.batchId,
							kind: row.kind,
							count: row.count,
							threshold: row.threshold,
						}),
					})
					if (!response.ok) throw new Error('coupon_batch_pager_unavailable')
				},
				(row) =>
					log
						.warn(
							row.kind === 'aging' || row.kind === 'stuck'
								? 'coupon_batch.worker_alarm'
								: 'coupon_batch.volume_alarm',
							{
								alertId: row.id,
								batchId: row.batchId,
								kind: row.kind,
								count: row.count,
								threshold: row.threshold,
							},
						)
						.then(() => {}),
			)
			return { attempted }
		})
	},
)
