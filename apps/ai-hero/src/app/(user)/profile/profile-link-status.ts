type ProfileOAuthAccount = {
	provider: string
	access_token?: string | null
}

export function hasUsableProfileOAuthAccount(
	accounts: readonly ProfileOAuthAccount[],
	provider: 'github' | 'discord',
) {
	return accounts.some(
		(account) => account.provider === provider && Boolean(account.access_token),
	)
}

export const githubProfileLinkStatuses = [
	'linked',
	'expired',
	'denied',
	'account-conflict',
	'not-enabled',
] as const

export type GithubProfileLinkStatus =
	(typeof githubProfileLinkStatuses)[number]

export function parseGithubProfileLinkStatus(
	value: string | undefined,
): GithubProfileLinkStatus | null {
	for (const status of githubProfileLinkStatuses) {
		if (value === status) return status
	}
	return null
}
