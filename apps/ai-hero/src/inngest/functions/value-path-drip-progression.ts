import { db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { classifyLearnerFlowContact } from '@/lib/subscriber-marketing/learner-flow-classifier'
import { progressValuePathDrips } from '@/lib/subscriber-marketing/value-path-drip-progression'
import { parseExecutorList } from '@/lib/subscriber-marketing/value-path-email-executor'
import {
	readActiveGateDRuntimeAllowlist,
	resolveGateDPreAuthorizedReviewReasons,
} from '@/lib/subscriber-marketing/value-path-gate-d-allowlist'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'

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
				funnel: 'skills-newsletter',
				reviewReasons: allowlistDecision.reviewReasons,
			})
			return {
				status: 'blocked',
				reviewReasons: allowlistDecision.reviewReasons,
			}
		}
		const allowlist = allowlistDecision.allowlist
		const config = await step.run('load-drip-config', () => ({
			scanLimit: Number(
				process.env.AIH_VALUE_PATH_DRIP_SCAN_LIMIT ?? DEFAULT_DRIP_SCAN_LIMIT,
			),
			minAgeHours: Number(process.env.AIH_VALUE_PATH_DRIP_MIN_AGE_HOURS ?? 18),
			acceptedReviewReasons: resolveGateDPreAuthorizedReviewReasons({
				allowlist,
				legacyEnvReviewReasons: parseExecutorList(
					process.env.AIH_VALUE_PATH_ACCEPTED_REVIEW_REASONS,
				),
			}),
		}))
		const now = new Date().toISOString()
		const maxCompletedAt = new Date(
			Date.parse(now) - config.minAgeHours * 60 * 60 * 1000,
		).toISOString()
		const repository = new DrizzleCaptureMarketingRepository(db)
		const completedScan = await step.run('load-completed-send-intents', () =>
			repository.findCompletedValuePathEmailSideEffectIntentScan({
				limit: config.scanLimit,
				maxCompletedAt,
				now,
				// Rolling enrollment authorizes any explicit public signup. The
				// activation's original contact list is not the live cohort.
				contactIds:
					allowlist.authorizationMode === 'rolling-public-enrollment'
						? undefined
						: allowlist.contactIds,
				valuePathSlugs: allowlist.pathSlugs,
				emailResourceIds: allowlist.emailResourceIds,
				kitSequenceIds: allowlist.kitSequenceIds,
			}),
		)
		const starved = await step.run('count-drip-starved-learners', async () => {
			const records = await repository.findSkillsWorkflowLearnerFlowRecords()
			return records.filter((record) => {
				const classification = classifyLearnerFlowContact({ ...record, now })
				return (
					classification.state === 'stuck' &&
					classification.cause === 'drip-starved'
				)
			}).length
		})
		const result = await step.run('progress-value-path-drips', () =>
			progressValuePathDrips({
				repository,
				allowlist,
				completedIntents: completedScan.intents,
				allowWrite: true,
				acceptedReviewReasons: config.acceptedReviewReasons,
				now,
			}),
		)
		const zeroPlanWhileStarved = result.counts.planned === 0 && starved > 0
		const scanTruncated = completedScan.diagnostics.truncated > 0
		await log[zeroPlanWhileStarved || scanTruncated ? 'warn' : 'info'](
			'subscriber_funnel.drip_run_completed',
			{
				funnel: 'skills-newsletter',
				...result.counts,
				noop: result.counts.idempotentNoop + result.counts.notDue,
				parked: result.counts.blocked,
				starved,
				zeroPlanWhileStarved,
				scanTruncated,
				...completedScan.diagnostics,
			},
		)
		return {
			...result,
			starved,
			zeroPlanWhileStarved,
			scanTruncated,
			scan: completedScan.diagnostics,
		}
	},
)
