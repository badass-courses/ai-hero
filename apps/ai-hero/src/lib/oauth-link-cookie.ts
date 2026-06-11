export const connectableOAuthProviders = ['discord', 'github'] as const

export type ConnectableOAuthProvider =
	(typeof connectableOAuthProviders)[number]

export function isConnectableOAuthProvider(
	provider: string,
): provider is ConnectableOAuthProvider {
	return connectableOAuthProviders.includes(
		provider as ConnectableOAuthProvider,
	)
}

export function getOAuthLinkCookieName(provider: ConnectableOAuthProvider) {
	return `__oauth-link-uid-${provider}`
}
