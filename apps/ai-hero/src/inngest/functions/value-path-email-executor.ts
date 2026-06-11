import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import { redis } from '@/server/redis-client'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
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
			acceptedReviewReasons: resolveGateDPreAuthorizedReviewReasons({
				allowlist: runtimeAllowlist,
				legacyEnvReviewReasons: parseExecutorList(
					process.env.AIH_VALUE_PATH_ACCEPTED_REVIEW_REASONS,
				),
			}),
		}))

		return await step.run('execute-pending-value-path-email-intents', () =>
			executePendingValuePathEmailIntents({
				repository: new DrizzleCaptureMarketingRepository(db),
				emailListProvider,
				config,
			}),
		)
	},
)
