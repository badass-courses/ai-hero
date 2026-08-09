import { db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { parseEmail7LiveEnabled } from '@/lib/subscriber-marketing/email-7-launch-gate'
import { reconcileLearnerFlow } from '@/lib/subscriber-marketing/learner-flow-reconciler'
import { readActiveGateDRuntimeAllowlist } from '@/lib/subscriber-marketing/value-path-gate-d-allowlist'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'

export const learnerFlowReconciler = inngest.createFunction(
	{
		id: 'learner-flow-reconciler',
		name: 'Learner flow: repair classifier truth',
		retries: 2,
		// One owner may repair or plan at a time. Intent idempotency remains the
		// retry guard inside the run; this guard stops overlapping plans.
		concurrency: 1,
	},
	[
		{ cron: '0 * * * *' },
		{ event: 'subscriber_funnel.reconciler_run_requested' },
	],
	async ({ step }) => {
		const allowlistDecision = await step.run('read-gate-d-allowlist', () =>
			readActiveGateDRuntimeAllowlist({ redis }),
		)
		if (!allowlistDecision.passed || !allowlistDecision.allowlist) {
			const blockedReceipt = {
				event: 'subscriber_funnel.drip_run_completed' as const,
				receiptVersion: 2 as const,
				funnel: 'skills-newsletter' as const,
				loop: 'repair' as const,
				status: 'blocked' as const,
				workSeen: 0,
				workDone: 0,
				oldestUnservedAt: null,
				oldestUnservedAgeHours: null,
				counts: {
					completionFactsRepaired: 0,
					intentsReplanned: 0,
					intentsCreated: 0,
					noop: 0,
					blocked: 0,
					notDue: 0,
					failed: 0,
					deferred: 0,
					writeFailed: 0,
					retriesExhausted: 0,
					permanentProviderFailures: 0,
					tier2: 0,
				},
				blockedReasons: {},
				failureReasons: allowlistDecision.reviewReasons,
				causeCounts: {},
				brake: { status: 'clear' as const, reasons: [] as string[] },
			}
			await step.run('write-blocked-reconciler-receipt', () =>
				log.warn(blockedReceipt.event, blockedReceipt),
			)
			return blockedReceipt
		}
		const allowlist = allowlistDecision.allowlist
		const now = await step.run('capture-reconciler-clock', () =>
			new Date().toISOString(),
		)
		const receipt = await step.run('repair-classifier-truth', () =>
			reconcileLearnerFlow({
				repository: new DrizzleCaptureMarketingRepository(db),
				allowlist,
				email7LiveEnabled: parseEmail7LiveEnabled(
					process.env.AIH_VALUE_PATH_EMAIL_7_LIVE_ENABLED,
				),
				now,
			}),
		)
		await step.run('write-reconciler-receipt', async () => {
			if (receipt.brake.status === 'tripped') {
				await log.error('subscriber_funnel.reconciler_brake_tripped', {
					...receipt,
					event: 'subscriber_funnel.reconciler_brake_tripped',
					severity: 'critical',
				})
			}
			await log[receipt.status === 'ok' ? 'info' : 'warn'](
				receipt.event,
				receipt,
			)
		})
		return receipt
	},
)
