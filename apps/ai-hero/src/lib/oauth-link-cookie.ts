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

export const legacyOAuthLinkCookieNames = connectableOAuthProviders.map(
	getOAuthLinkCookieName,
)

type CookieDeleter = {
	delete(name: string): unknown
}

export function clearLegacyOAuthLinkCookies(cookieStore: CookieDeleter) {
	for (const cookieName of legacyOAuthLinkCookieNames) {
		cookieStore.delete(cookieName)
	}
}
