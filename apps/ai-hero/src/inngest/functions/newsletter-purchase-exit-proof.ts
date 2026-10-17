import { db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	findCrashCoursePurchaseStatuses,
	purchaseExitProofEnabled,
} from '@/lib/subscriber-marketing/purchase-exit-proof.server'
import { runPurchaseHandoffExitPass } from '@/lib/subscriber-marketing/purchase-handoff-exit'
import { log } from '@/server/logger'

/**
 * Scheduled producer of purchase-handoff exit receipts. Off unless the
 * `purchase-exit-proof` admin flag is on. The receipt flows through the same
 * replay as the operator chain; this function only supplies the proof.
 */
export const newsletterPurchaseExitProof = inngest.createFunction(
	{
		id: 'newsletter-purchase-exit-proof-v1',
		name: 'Newsletter: accept purchase handoff as exit proof',
		retries: 1,
		concurrency: 1,
	},
	{ cron: '*/5 * * * *' },
	async ({ step }) => {
		const result = await step.run('produce-purchase-handoff-exits', () =>
			runPurchaseHandoffExitPass({
				repository: new DrizzleCaptureMarketingRepository(db),
				isEnabled: purchaseExitProofEnabled,
				findCrashCoursePurchaseStatuses,
				now: new Date().toISOString(),
			}),
		)
		if (result.status === 'ran' && result.results.length > 0) {
			await log.info('newsletter.purchase_exit_proof', {
				outcomes: result.results.reduce<Record<string, number>>(
					(acc, row) => {
						acc[row.outcome] = (acc[row.outcome] ?? 0) + 1
						return acc
					},
					{},
				),
			})
		}
		return result
	},
)
