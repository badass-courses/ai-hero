import { db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	findCrashCoursePurchaseStatuses,
	purchaseExitProofEnabled,
} from '@/lib/subscriber-marketing/purchase-exit-proof.server'
import {
	runPurchaseHandoffExitPage,
	type PurchaseHandoffExitCursor,
	type PurchaseHandoffExitPageResult,
} from '@/lib/subscriber-marketing/purchase-handoff-exit'
import { log } from '@/server/logger'

const MAX_PAGES = 100

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
	{ cron: '*/15 * * * *' },
	async ({ step }) => {
		const deps = () => ({
			repository: new DrizzleCaptureMarketingRepository(db),
			isEnabled: purchaseExitProofEnabled,
			findCrashCoursePurchaseStatuses,
			now: new Date().toISOString(),
		})
		const outcomes: Record<string, number> = {}
		let after: PurchaseHandoffExitCursor | undefined
		// One step per page; the flag is re-read at the top of each page.
		for (let page = 0; page < MAX_PAGES; page++) {
			const result: PurchaseHandoffExitPageResult = await step.run(
				`purchase-handoff-exits-page-${page}`,
				() => runPurchaseHandoffExitPage({ ...deps(), after }),
			)
			if (result.status === 'disabled') break
			for (const row of result.results)
				outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1
			if (!result.next) break
			after = result.next
		}
		if (Object.keys(outcomes).length > 0)
			await log.info('newsletter.purchase_exit_proof', { outcomes })
		return { outcomes }
	},
)
