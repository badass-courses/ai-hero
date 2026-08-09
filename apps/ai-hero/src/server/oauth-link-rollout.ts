import { env } from '@/env.mjs'

export type OAuthLinkRolloutConfig = {
	allowedUserIds: ReadonlySet<string>
	globalEnabled: boolean
}

export function parseOAuthLinkUserAllowlist(value: string | undefined) {
	return new Set(
		(value ?? '')
			.split(',')
			.map((userId) => userId.trim())
			.filter(Boolean),
	)
}

export function isOAuthLinkEnabledForUser(
	userId: string,
	config: OAuthLinkRolloutConfig,
) {
	return config.allowedUserIds.has(userId) || config.globalEnabled
}

export const oauthLinkRolloutConfig: OAuthLinkRolloutConfig = {
	allowedUserIds: parseOAuthLinkUserAllowlist(
		env.AIH_DISCORD_RELINK_USER_ALLOWLIST,
	),
	globalEnabled: env.AIH_DISCORD_RELINK_GLOBAL_ENABLED === 'true',
}

export function isDiscordRelinkEnabledForUser(userId: string) {
	return isOAuthLinkEnabledForUser(userId, oauthLinkRolloutConfig)
}
