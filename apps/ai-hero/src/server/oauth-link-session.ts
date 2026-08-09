import {
	readAuthSessionToken,
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
}: {
	getCookieStore: () => OAuthCookieStore | Promise<OAuthCookieStore>
	getSessionAndUser: (
		sessionToken: string,
	) => SessionAndUser | null | PromiseLike<SessionAndUser | null>
	now?: () => Date
}) {
	return async (): Promise<AuthenticatedOAuthLinkSession | null> => {
		const sessionToken = readAuthSessionToken(await getCookieStore())
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
