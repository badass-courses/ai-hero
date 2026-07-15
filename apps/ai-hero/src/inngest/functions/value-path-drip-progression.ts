import { db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { progressValuePathDrips } from '@/lib/subscriber-marketing/value-path-drip-progression'
import { parseExecutorList } from '@/lib/subscriber-marketing/value-path-email-executor'
import {
	readActiveGateDRuntimeAllowlist,
	resolveGateDPreAuthorizedReviewReasons,
} from '@/lib/subscriber-marketing/value-path-gate-d-allowlist'

const DEFAULT_DRIP_SCAN_LIMIT = 200

export const valuePathDripProgression = inngest.createFunction(
	{
		id: 'value-path-drip-progression',
		retries: 2,
		concurrency: 1,
	},
	{ cron: '0 * * * *' },
	async ({ step }) => {
		const allowlistDecision = await step.run('read-gate-d-allowlist', () =>
			readActiveGateDRuntimeAllowlist({ redis }),
		)
		if (!allowlistDecision.passed || !allowlistDecision.allowlist) {
			await log.warn('subscriber_funnel.drip_blocked', {
				funnel: 'skills-newsletter', reviewReasons: allowlistDecision.reviewReasons,
			})
			return {
				status: 'blocked',
				reviewReasons: allowlistDecision.reviewReasons,
			}
		}
		const config = await step.run('load-drip-config', () => ({
			scanLimit: Number(
				process.env.AIH_VALUE_PATH_DRIP_SCAN_LIMIT ?? DEFAULT_DRIP_SCAN_LIMIT,
			),
			minAgeHours: Number(process.env.AIH_VALUE_PATH_DRIP_MIN_AGE_HOURS ?? 18),
			acceptedReviewReasons: resolveGateDPreAuthorizedReviewReasons({
				allowlist: allowlistDecision.allowlist,
				legacyEnvReviewReasons: parseExecutorList(
					process.env.AIH_VALUE_PATH_ACCEPTED_REVIEW_REASONS,
				),
			}),
		}))
		const maxCompletedAt = new Date(
			Date.now() - config.minAgeHours * 60 * 60 * 1000,
		).toISOString()
		const repository = new DrizzleCaptureMarketingRepository(db)
		const completedIntents = await step.run(
			'load-completed-send-intents',
			async () =>
				(
					await repository.findCompletedValuePathEmailSideEffectIntents({
						limit: config.scanLimit,
						maxCompletedAt,
					})
				).filter(
					(intent) =>
						allowlistDecision.allowlist!.contactIds.includes(
							intent.contactId,
						) &&
						allowlistDecision.allowlist!.emailResourceIds.includes(
							String(intent.metadata.emailResourceId ?? ''),
						) &&
						allowlistDecision.allowlist!.kitSequenceIds.includes(
							String(intent.metadata.kitSequenceId ?? ''),
						),
				),
		)
		const result = await step.run('progress-value-path-drips', () =>
			progressValuePathDrips({
				repository,
				allowlist: allowlistDecision.allowlist!,
				completedIntents,
				allowWrite: true,
				acceptedReviewReasons: config.acceptedReviewReasons,
			}),
		)
		await log.info('subscriber_funnel.drip_run_completed', {
			funnel: 'skills-newsletter', ...result.counts,
			noop: result.counts.idempotentNoop + result.counts.notDue,
			parked: result.counts.blocked,
		})
		return result
	},
)
