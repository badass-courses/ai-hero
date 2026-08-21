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

export type OAuthCookiePolicy = {
	secure: boolean
	authSessionCookieName: (typeof authSessionCookieNames)[number]
	unexpectedAuthSessionCookieName: (typeof authSessionCookieNames)[number]
	oauthLinkIntentCookieName: (typeof oauthLinkIntentCookieNames)[number]
	unexpectedOAuthLinkIntentCookieName: (typeof oauthLinkIntentCookieNames)[number]
}

export function createOAuthCookiePolicy(secure: boolean): OAuthCookiePolicy {
	return {
		secure,
		authSessionCookieName: authSessionCookieNames[secure ? 1 : 0],
		unexpectedAuthSessionCookieName: authSessionCookieNames[secure ? 0 : 1],
		oauthLinkIntentCookieName: oauthLinkIntentCookieNames[secure ? 1 : 0],
		unexpectedOAuthLinkIntentCookieName:
			oauthLinkIntentCookieNames[secure ? 0 : 1],
	}
}

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

function readExpectedCookie(
	cookieStore: OAuthCookieStore,
	input: { expectedName: string; unexpectedName: string; label: string },
) {
	const expectedValue = cookieStore.get?.(input.expectedName)?.value
	const unexpectedValue = cookieStore.get?.(input.unexpectedName)?.value
	if (unexpectedValue && unexpectedValue !== expectedValue) {
		throw new Error(`${input.label} cookie selection is ambiguous`)
	}
	return expectedValue ?? null
}

export function readOAuthLinkIntentToken(
	cookieStore: OAuthCookieStore,
	policy: OAuthCookiePolicy,
) {
	return readExpectedCookie(cookieStore, {
		expectedName: policy.oauthLinkIntentCookieName,
		unexpectedName: policy.unexpectedOAuthLinkIntentCookieName,
		label: 'OAuth link intent',
	})
}

export function readAuthSessionToken(
	cookieStore: OAuthCookieStore,
	policy: OAuthCookiePolicy,
) {
	return readExpectedCookie(cookieStore, {
		expectedName: policy.authSessionCookieName,
		unexpectedName: policy.unexpectedAuthSessionCookieName,
		label: 'OAuth link session',
	})
}

export function writeOAuthLinkIntentCookie(
	cookieStore: OAuthCookieStore,
	input: { rawToken: string; expiresAt: Date },
	policy: OAuthCookiePolicy,
) {
	if (!cookieStore.set) throw new Error('OAuth link cookie store is read-only')
	cookieStore.set(policy.oauthLinkIntentCookieName, input.rawToken, {
		httpOnly: true,
		secure: policy.secure,
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
