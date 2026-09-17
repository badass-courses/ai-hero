import { parseValuePathProviderPacingMs } from '@/inngest/functions/value-path-provider-pacing'

import { parseEmail7LiveEnabled } from './email-7-launch-gate'
import type { ValuePathAnswerPageResource } from './value-path-answer-page'
import {
	parseExecutorList,
	type ValuePathEmailExecutorConfig,
} from './value-path-email-executor'
import {
	resolveGateDPreAuthorizedReviewReasons,
	type GateDRuntimeAllowlist,
} from './value-path-gate-d-allowlist'

/**
 * One config for every caller of the value-path email executor: the cron
 * and drovr's synchronous route read the same allowlist, the same env, and
 * the same gates, so a send is the same send whichever path asked for it.
 */
export function buildValuePathExecutorConfig(args: {
	runtimeAllowlist: GateDRuntimeAllowlist
	answerPages: ValuePathAnswerPageResource[]
	env: Readonly<Record<string, string | undefined>>
}): ValuePathEmailExecutorConfig {
	const { runtimeAllowlist, answerPages, env } = args
	return {
		mode: runtimeAllowlist.mode,
		limit:
			runtimeAllowlist.maxSendsPerRun ??
			Number(env.AIH_VALUE_PATH_EXECUTOR_LIMIT ?? 25),
		baseUrl:
			env.NEXT_PUBLIC_URL ??
			env.NEXT_PUBLIC_SITE_URL ??
			'https://www.aihero.dev',
		pathTokenSecret: env.AI_HERO_VALUE_PATH_TOKEN_SECRET,
		answerPages,
		allowlistedContactIds: runtimeAllowlist.contactIds,
		allowlistedKitSubscriberIds: runtimeAllowlist.kitSubscriberIds,
		allowlistedEmails: runtimeAllowlist.emails,
		enabledValuePathSlugs: runtimeAllowlist.pathSlugs,
		verifiedEmailResourceIds: runtimeAllowlist.emailResourceIds,
		verifiedKitSequenceIds: runtimeAllowlist.kitSequenceIds,
		allowedActions: runtimeAllowlist.allowedActions,
		retryPolicy: runtimeAllowlist.retryPolicy,
		// The cron is one sender: keep its Kit writes ten seconds apart so a
		// backlog drain cannot recreate the provider-rate-limit spike.
		providerPacingMs: parseValuePathProviderPacingMs(
			env.AIH_VALUE_PATH_PROVIDER_PACING_MS,
		),
		email7LiveEnabled: parseEmail7LiveEnabled(
			env.AIH_VALUE_PATH_EMAIL_7_LIVE_ENABLED,
		),
		acceptedReviewReasons: resolveGateDPreAuthorizedReviewReasons({
			allowlist: runtimeAllowlist,
			legacyEnvReviewReasons: parseExecutorList(
				env.AIH_VALUE_PATH_ACCEPTED_REVIEW_REASONS,
			),
		}),
	}
}
