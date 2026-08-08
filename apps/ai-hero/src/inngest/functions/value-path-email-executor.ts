import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { parseEmail7LiveEnabled } from '@/lib/subscriber-marketing/email-7-launch-gate'
import {
	getValuePathAnswerPages,
	type ValuePathAnswerPageResource,
} from '@/lib/subscriber-marketing/value-path-answer-page'
import {
	executePendingValuePathEmailIntents,
	parseExecutorList,
} from '@/lib/subscriber-marketing/value-path-email-executor'
import {
	readActiveGateDRuntimeAllowlist,
	resolveGateDPreAuthorizedReviewReasons,
} from '@/lib/subscriber-marketing/value-path-gate-d-allowlist'

import { parseValuePathProviderPacingMs } from './value-path-provider-pacing'

export const valuePathEmailExecutor = inngest.createFunction(
	{
		id: 'value-path-email-executor',
		retries: 2,
		concurrency: 1,
	},
	{ cron: '*/5 * * * *' },
	async ({ step }) => {
		const allowlistDecision = await step.run('read-gate-d-allowlist', () =>
			readActiveGateDRuntimeAllowlist({ redis }),
		)
		if (!allowlistDecision.passed || !allowlistDecision.allowlist) {
			await log.warn('subscriber_funnel.email_executor_blocked', {
				funnel: 'skills-newsletter', reviewReasons: allowlistDecision.reviewReasons,
			})
			return {
				status: 'blocked',
				reviewReasons: allowlistDecision.reviewReasons,
			}
		}
		const runtimeAllowlist = allowlistDecision.allowlist
		const answerPages = (await step.run('load-answer-pages', () =>
			getValuePathAnswerPages(),
		)) as ValuePathAnswerPageResource[]
		const config = await step.run('load-send-gate-config', () => ({
			mode: runtimeAllowlist.mode,
			limit:
				runtimeAllowlist?.maxSendsPerRun ??
				Number(process.env.AIH_VALUE_PATH_EXECUTOR_LIMIT ?? 25),
			baseUrl:
				process.env.NEXT_PUBLIC_URL ??
				process.env.NEXT_PUBLIC_SITE_URL ??
				'https://www.aihero.dev',
			pathTokenSecret: process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET,
			answerPages,
			allowlistedContactIds: runtimeAllowlist.contactIds,
			allowlistedKitSubscriberIds: runtimeAllowlist.kitSubscriberIds,
			allowlistedEmails: runtimeAllowlist.emails,
			enabledValuePathSlugs: runtimeAllowlist.pathSlugs,
			verifiedEmailResourceIds: runtimeAllowlist.emailResourceIds,
			verifiedKitSequenceIds: runtimeAllowlist.kitSequenceIds,
			allowedActions: runtimeAllowlist?.allowedActions,
			retryPolicy: runtimeAllowlist?.retryPolicy,
			// This cron is the single sender. Keep Kit writes ten seconds apart by
			// default so a backlog drain cannot recreate the provider-rate-limit spike.
			providerPacingMs: parseValuePathProviderPacingMs(
				process.env.AIH_VALUE_PATH_PROVIDER_PACING_MS,
			),
			email7LiveEnabled: parseEmail7LiveEnabled(
				process.env.AIH_VALUE_PATH_EMAIL_7_LIVE_ENABLED,
			),
			acceptedReviewReasons: resolveGateDPreAuthorizedReviewReasons({
				allowlist: runtimeAllowlist,
				legacyEnvReviewReasons: parseExecutorList(
					process.env.AIH_VALUE_PATH_ACCEPTED_REVIEW_REASONS,
				),
			}),
		}))

		const results = await step.run('execute-pending-value-path-email-intents', () =>
			executePendingValuePathEmailIntents({
				repository: new DrizzleCaptureMarketingRepository(db),
				emailListProvider,
				config,
			}),
		)
		for (const result of results) {
			const level = result.status === 'failed' || result.status === 'retryable-failed' ? 'error' : result.status === 'blocked' ? 'warn' : 'info'
			await log[level]('subscriber_funnel.email_intent_result', {
				funnel: 'skills-newsletter', intentId: result.intentId,
				status: result.status, reviewReasons: 'reviewReasons' in result ? result.reviewReasons : [],
			})
		}
		const counts = {
			processed: results.length,
			completed: results.filter((result) => result.status === 'completed').length,
			blocked: results.filter((result) => result.status === 'blocked').length,
			failed: results.filter((result) => result.status === 'failed').length,
			retryableFailed: results.filter(
				(result) => result.status === 'retryable-failed',
			).length,
			skipped: results.filter((result) => result.status === 'skipped').length,
		}
		const failureReasons = Array.from(
			new Set(
				results.flatMap((result) =>
					'reviewReasons' in result ? result.reviewReasons : [],
				),
			),
		)
		const receipt = {
			event: 'subscriber_funnel.email_executor_run_completed' as const,
			receiptVersion: 2 as const,
			funnel: 'skills-newsletter' as const,
			loop: 'executor' as const,
			status:
				counts.failed > 0 ||
				counts.retryableFailed > 0 ||
				counts.blocked > 0
					? ('degraded' as const)
					: ('ok' as const),
			workSeen: counts.processed,
			workDone: counts.completed,
			oldestUnservedAt: null,
			oldestUnservedAgeHours: null,
			counts,
			failureReasons,
		}
		await log[receipt.status === 'degraded' ? 'warn' : 'info'](
			receipt.event,
			receipt,
		)
		return results
	},
)
