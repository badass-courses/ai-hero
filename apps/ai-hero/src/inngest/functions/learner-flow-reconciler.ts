import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { parseEmail7LiveEnabled } from '@/lib/subscriber-marketing/email-7-launch-gate'
import {
	LEARNER_FLOW_RECONCILER_CHECK_COMMAND,
	reconcileLearnerFlow,
} from '@/lib/subscriber-marketing/learner-flow-reconciler'
import {
	getValuePathAnswerPages,
	type ValuePathAnswerPageResource,
} from '@/lib/subscriber-marketing/value-path-answer-page'
import { parseExecutorList } from '@/lib/subscriber-marketing/value-path-email-executor'
import {
	readActiveGateDRuntimeAllowlist,
	resolveGateDPreAuthorizedReviewReasons,
} from '@/lib/subscriber-marketing/value-path-gate-d-allowlist'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'

export const learnerFlowReconciler = inngest.createFunction(
	{
		id: 'learner-flow-reconciler',
		name: 'Learner flow: reconcile classifier truth',
		retries: 2,
		// One owner may plan/create at a time. Intent idempotency remains the
		// retry guard inside the run; this guard stops overlapping plans.
		concurrency: 1,
	},
	{ cron: '0 * * * *' },
	async ({ step }) => {
		const allowlistDecision = await step.run('read-gate-d-allowlist', () =>
			readActiveGateDRuntimeAllowlist({ redis }),
		)
		if (!allowlistDecision.passed || !allowlistDecision.allowlist) {
			const blockedReceipt = {
				event: 'subscriber_funnel.drip_run_completed' as const,
				receiptVersion: 1 as const,
				funnel: 'skills-newsletter' as const,
				loop: 'reconciler' as const,
				status: 'blocked' as const,
				plannerSource: 'learner-flow-classifier' as const,
				brake: 'clear' as const,
				workSeen: 0,
				workDone: 0,
				oldestUnservedAgeHours: null,
				oldestUnservedAt: null,
				created: 0,
				served: 0,
				deferred: 0,
				planned: 0,
				completedIntents: 0,
				starved: 0,
				zeroPlanWhileStarved: false,
				scanTruncated: false,
				parked: 1,
				reviewReasons: allowlistDecision.reviewReasons,
				dmPriority: 'high' as const,
				dmLine: `RECONCILER BLOCKED: Gate D is unavailable (${allowlistDecision.reviewReasons.join(', ')}). Check: ${LEARNER_FLOW_RECONCILER_CHECK_COMMAND}. Action: restore the active allowlist before the next hourly run.`,
			}
			await step.run('write-blocked-reconciler-receipt', () =>
				log.warn(blockedReceipt.event, blockedReceipt),
			)
			return blockedReceipt
		}
		const allowlist = allowlistDecision.allowlist
		const answerPages = (await step.run('load-answer-pages', () =>
			getValuePathAnswerPages(),
		)) as ValuePathAnswerPageResource[]
		const now = await step.run('capture-reconciler-clock', () =>
			new Date().toISOString(),
		)
		const receipt = await step.run('reconcile-classifier-truth', () =>
			reconcileLearnerFlow({
				repository: new DrizzleCaptureMarketingRepository(db),
				allowlist,
				emailListProvider,
				now,
				executorConfig: {
					mode: allowlist.mode,
					baseUrl:
						process.env.NEXT_PUBLIC_URL ??
						process.env.NEXT_PUBLIC_SITE_URL ??
						'https://www.aihero.dev',
					pathTokenSecret: process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET,
					answerPages,
					allowlistedContactIds: allowlist.contactIds,
					allowlistedKitSubscriberIds: allowlist.kitSubscriberIds,
					allowlistedEmails: allowlist.emails,
					enabledValuePathSlugs: allowlist.pathSlugs,
					verifiedEmailResourceIds: allowlist.emailResourceIds,
					verifiedKitSequenceIds: allowlist.kitSequenceIds,
					allowedActions: allowlist.allowedActions,
					retryPolicy: allowlist.retryPolicy,
					email7LiveEnabled: parseEmail7LiveEnabled(
						process.env.AIH_VALUE_PATH_EMAIL_7_LIVE_ENABLED,
					),
					acceptedReviewReasons: resolveGateDPreAuthorizedReviewReasons({
						allowlist,
						legacyEnvReviewReasons: parseExecutorList(
							process.env.AIH_VALUE_PATH_ACCEPTED_REVIEW_REASONS,
						),
					}),
				},
			}),
		)
		await step.run('write-reconciler-receipt', async () => {
			if (receipt.brake === 'tripped') {
				await log.error('subscriber_funnel.reconciler_brake_tripped', {
					...receipt,
					event: 'subscriber_funnel.reconciler_brake_tripped',
					severity: 'critical',
				})
			}
			const level =
				receipt.brake === 'tripped' ||
				receipt.executor.failed > 0 ||
				receipt.executor.retryableFailed > 0 ||
				receipt.tier2 > 0
					? 'warn'
					: 'info'
			await log[level](receipt.event, receipt)
		})
		return receipt
	},
)
