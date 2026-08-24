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

export const oauthLinkIntentCookieNames = [
	'aih-oauth-link-intent',
	'__Host-aih-oauth-link-intent',
] as const

export const authSessionCookieNames = [
	'authjs.session-token',
	'__Secure-authjs.session-token',
] as const

type CookieValue = { value: string }

export type OAuthCookieStore = {
	delete(name: string): unknown
	get?(name: string): CookieValue | undefined
	set?(
		name: string,
		value: string,
		options: {
			httpOnly: boolean
			secure: boolean
			sameSite: 'lax'
			path: '/'
			expires: Date
		},
	): unknown
}

function readFirstCookie(
	cookieStore: OAuthCookieStore,
	names: readonly string[],
) {
	for (const name of names) {
		const value = cookieStore.get?.(name)?.value
		if (value) return value
	}
	return null
}

export function readOAuthLinkIntentToken(cookieStore: OAuthCookieStore) {
	return readFirstCookie(cookieStore, oauthLinkIntentCookieNames)
}

export function readAuthSessionToken(cookieStore: OAuthCookieStore) {
	return readFirstCookie(cookieStore, authSessionCookieNames)
}

export function writeOAuthLinkIntentCookie(
	cookieStore: OAuthCookieStore,
	input: { rawToken: string; expiresAt: Date },
) {
	if (!cookieStore.set) throw new Error('OAuth link cookie store is read-only')
	const secure = process.env.NODE_ENV === 'production'
	const name = secure
		? oauthLinkIntentCookieNames[1]
		: oauthLinkIntentCookieNames[0]
	cookieStore.set(name, input.rawToken, {
		httpOnly: true,
		secure,
		sameSite: 'lax',
		path: '/',
		expires: input.expiresAt,
	})
}

export function clearOAuthLinkIntentCookies(cookieStore: OAuthCookieStore) {
	for (const cookieName of oauthLinkIntentCookieNames) {
		cookieStore.delete(cookieName)
	}
}

export function clearLegacyOAuthLinkCookies(cookieStore: OAuthCookieStore) {
	for (const cookieName of legacyOAuthLinkCookieNames) {
		cookieStore.delete(cookieName)
	}
}
