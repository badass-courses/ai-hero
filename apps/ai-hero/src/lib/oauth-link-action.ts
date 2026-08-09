import type { ConnectableOAuthProvider } from './oauth-link-cookie'
import { hashOAuthLinkSession } from '@/server/oauth-link-intent'

type AuthenticatedSession = {
	userId: string
	sessionToken: string
}

type OAuthAccountLinkRequestDependencies = {
	getAuthenticatedSession: () =>
		| AuthenticatedSession
		| null
		| Promise<AuthenticatedSession | null>
	isUserAllowed: (userId: string) => boolean
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
	writeIntentCookie: (input: {
		rawToken: string
		expiresAt: Date
	}) => void | Promise<void>
}

/**
 * The request takes no caller identity or provider. Discord and the target user
 * both come from trusted server state.
 */
export function createOAuthAccountLinkRequest({
	getAuthenticatedSession,
	isUserAllowed,
	findAccount,
	issueIntent,
	writeIntentCookie,
}: OAuthAccountLinkRequestDependencies) {
	return async function requestOAuthAccountLink() {
		const session = await getAuthenticatedSession()
		if (!session) return { status: 'unauthenticated' as const }

		if (!isUserAllowed(session.userId)) {
			return {
				status: 'rollout-denied' as const,
				targetUserId: session.userId,
			}
		}

		const provider = 'discord' satisfies ConnectableOAuthProvider
		const existingAccount = await findAccount({
			userId: session.userId,
			provider,
		})
		if (existingAccount?.access_token) return { status: 'linked' as const }

		try {
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
