import {
	readAuthSessionToken,
	type OAuthCookiePolicy,
	type OAuthCookieStore,
} from '@/lib/oauth-link-cookie'

export type AuthenticatedOAuthLinkSession = {
	userId: string
	sessionToken: string
}

type SessionAndUser = {
	session: { userId: string; expires: Date }
	user: { id: string }
}

export function createAuthenticatedOAuthLinkSessionResolver({
	getCookieStore,
	getSessionAndUser,
	now = () => new Date(),
	getCookiePolicy,
}: {
	getCookieStore: () => OAuthCookieStore | Promise<OAuthCookieStore>
	getSessionAndUser: (
		sessionToken: string,
	) => SessionAndUser | null | PromiseLike<SessionAndUser | null>
	now?: () => Date
	getCookiePolicy: () => OAuthCookiePolicy | Promise<OAuthCookiePolicy>
}) {
	return async (): Promise<AuthenticatedOAuthLinkSession | null> => {
		const [cookieStore, cookiePolicy] = await Promise.all([
			getCookieStore(),
			getCookiePolicy(),
		])
		const sessionToken = readAuthSessionToken(cookieStore, cookiePolicy)
		if (!sessionToken) return null
		const result = await getSessionAndUser(sessionToken)
		if (
			!result ||
			result.session.userId !== result.user.id ||
			result.session.expires <= now()
		) {
			return null
		}
		return { userId: result.user.id, sessionToken }
	}
}
