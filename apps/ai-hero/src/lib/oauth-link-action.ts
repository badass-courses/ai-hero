import type { ConnectableOAuthProvider } from './oauth-link-cookie'
import { hashOAuthLinkSession } from '@/server/oauth-link-intent'

type AuthenticatedSession = {
	userId: string
	sessionToken: string
}

type OAuthAccountSwitchLoginDependencies = {
	signOut: (options: { redirectTo: string }) => Promise<unknown>
}

type OAuthAccountLinkRequestDependencies = {
	provider: ConnectableOAuthProvider
	getAuthenticatedSession: () =>
		| AuthenticatedSession
		| null
		| Promise<AuthenticatedSession | null>
	findAccount: (input: {
		userId: string
		provider: ConnectableOAuthProvider
	}) =>
		| { access_token?: string | null }
		| null
		| undefined
		| PromiseLike<{ access_token?: string | null } | null | undefined>
	issueIntent: (input: {
		targetUserId: string
		provider: ConnectableOAuthProvider
		sessionBinding: string
	}) => Promise<{ rawToken: string; expiresAt: Date }>
	clearIntentCookies: () => void | Promise<void>
	writeIntentCookie: (input: {
		rawToken: string
		expiresAt: Date
	}) => void | Promise<void>
	isUserAllowed?: (userId: string) => boolean | Promise<boolean>
}

export function createOAuthAccountSwitchLogin({
	signOut,
}: OAuthAccountSwitchLoginDependencies) {
	return async function switchOAuthAccountLogin() {
		await signOut({ redirectTo: '/login?callbackUrl=/discord' })
	}
}

/**
 * The returned action takes no caller identity or provider. The provider is
 * fixed when the server constructs the action, while the target user and
 * session binding come from the authenticated database session.
 */
export function createOAuthAccountLinkRequest({
	provider,
	getAuthenticatedSession,
	findAccount,
	issueIntent,
	clearIntentCookies,
	writeIntentCookie,
	isUserAllowed = () => true,
}: OAuthAccountLinkRequestDependencies) {
	return async function requestOAuthAccountLink() {
		const session = await getAuthenticatedSession()
		if (!session) return { status: 'unauthenticated' as const }

		const existingAccount = await findAccount({
			userId: session.userId,
			provider,
		})
		if (existingAccount?.access_token) return { status: 'linked' as const }
		if (!(await isUserAllowed(session.userId))) {
			return { status: 'rollout-denied' as const }
		}

		try {
			await clearIntentCookies()
			const issued = await issueIntent({
				targetUserId: session.userId,
				provider,
				sessionBinding: hashOAuthLinkSession(session.sessionToken),
			})
			await writeIntentCookie(issued)
			return { status: 'ready' as const }
		} catch {
			return { status: 'denied' as const }
		}
	}
}
