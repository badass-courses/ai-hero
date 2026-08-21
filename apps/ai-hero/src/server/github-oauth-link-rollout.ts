import 'server-only'

import { env } from '@/env.mjs'

export type GithubOAuthLinkRolloutConfig = {
	allowedUserIds: ReadonlySet<string>
	globalEnabled: boolean
}

export function parseGithubOAuthLinkUserAllowlist(value: string | undefined) {
	return new Set(
		(value ?? '')
			.split(',')
			.map((userId) => userId.trim())
			.filter(Boolean),
	)
}

export function isGithubOAuthLinkEnabled(
	userId: string,
	config: GithubOAuthLinkRolloutConfig,
) {
	return config.allowedUserIds.has(userId) || config.globalEnabled
}

export const githubOAuthLinkRolloutConfig: GithubOAuthLinkRolloutConfig = {
	allowedUserIds: parseGithubOAuthLinkUserAllowlist(
		env.AIH_GITHUB_RELINK_USER_ALLOWLIST,
	),
	globalEnabled: env.AIH_GITHUB_RELINK_GLOBAL_ENABLED === 'true',
}

export function isGithubOAuthLinkEnabledForUser(userId: string) {
	return isGithubOAuthLinkEnabled(userId, githubOAuthLinkRolloutConfig)
}
