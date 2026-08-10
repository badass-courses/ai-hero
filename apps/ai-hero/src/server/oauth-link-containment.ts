import { AsyncLocalStorage } from 'node:async_hooks'

import {
	clearLegacyOAuthLinkCookies,
	clearOAuthLinkIntentCookies,
	isConnectableOAuthProvider,
	readOAuthLinkIntentToken,
	type ConnectableOAuthProvider,
	type OAuthCookieStore,
} from '@/lib/oauth-link-cookie'
import {
	getOAuthLinkFlowId,
	hashOAuthLinkSession,
	redactOAuthLinkRef,
	type OAuthLinkAccount,
	type OAuthLinkCanaryEvent,
} from '@/server/oauth-link-intent'
import type { AuthenticatedOAuthLinkSession } from '@/server/oauth-link-session'

import type {
	Adapter,
	AdapterAccount,
	AdapterSession,
	AdapterUser,
} from '@auth/core/adapters'

type SignInAccount = {
	provider?: string | null
	providerAccountId?: string | null
	type?: string | null
	[key: string]: unknown
} | null

type AccountOwner = { id: string } | null

type OAuthContainmentDependencies = {
	getCookieStore: () => OAuthCookieStore | Promise<OAuthCookieStore>
	findAccountOwner: (account: {
		provider: ConnectableOAuthProvider
		providerAccountId: string
	}) => AccountOwner | Promise<AccountOwner>
	getAuthenticatedSession?: () =>
		| AuthenticatedOAuthLinkSession
		| null
		| Promise<AuthenticatedOAuthLinkSession | null>
	consumeLinkIntent?: (input: {
		rawToken: string
		provider: ConnectableOAuthProvider
		sessionBinding: string
		account: OAuthLinkAccount
	}) => Promise<
		| {
				status: 'linked'
				targetUserId: string
				linkKind: 'created' | 'renewed'
				flowId: string
		  }
		| { status: 'expired' | 'denied' }
	>
	observe?: (event: OAuthLinkCanaryEvent) => void | Promise<void>
}

type ContainedAccountAuthorization = {
	provider: ConnectableOAuthProvider
	providerAccountId: string
	ownerId: string
}

type PendingOAuthLink = {
	account: OAuthLinkAccount
	targetUserId: string
	linkKind: 'created' | 'renewed'
	flowId: string
}

type OAuthContainmentRequest = {
	requestProvider: string | null
	authorizedAccount: ContainedAccountAuthorization | null
	ordinaryOAuthAllowed: boolean
	pendingLink: PendingOAuthLink | null
	finalOwnershipVerified: boolean
	observe?: (event: OAuthLinkCanaryEvent) => void | Promise<void>
}

const oauthContainmentRequests =
	new AsyncLocalStorage<OAuthContainmentRequest>()

export class OAuthContainmentError extends Error {
	constructor(message: string) {
		super(`OAuth containment: ${message}`)
		this.name = 'OAuthContainmentError'
	}
}

function getCallbackProvider(request: Request): string | null {
	const segments = new URL(request.url).pathname.split('/').filter(Boolean)
	const callbackIndex = segments.lastIndexOf('callback')
	return callbackIndex === -1 ? null : (segments[callbackIndex + 1] ?? null)
}

/**
 * Gives one Auth.js route invocation its own containment state. The callback
 * binds an exact account to this state, and the adapter checks that binding at
 * every contained read or mutation boundary.
 */
export function runWithOAuthContainmentRequest<T>(
	request: Request,
	operation: () => T,
	observe?: (event: OAuthLinkCanaryEvent) => void | Promise<void>,
): T {
	return oauthContainmentRequests.run(
		{
			requestProvider: getCallbackProvider(request),
			authorizedAccount: null,
			ordinaryOAuthAllowed: false,
			pendingLink: null,
			finalOwnershipVerified: false,
			observe,
		},
		operation,
	)
}

function containedRequestFor(
	provider: ConnectableOAuthProvider,
): OAuthContainmentRequest | null {
	const request = oauthContainmentRequests.getStore()
	return request?.requestProvider === provider ? request : null
}

async function assertContainedAccountRead(
	request: OAuthContainmentRequest,
	account: Pick<AdapterAccount, 'provider' | 'providerAccountId'>,
	owner: AdapterUser | null,
) {
	const authorization = request.authorizedAccount
	if (!authorization) return

	if (
		authorization.provider !== account.provider ||
		authorization.providerAccountId !== account.providerAccountId ||
		owner?.id !== authorization.ownerId
	) {
		if (request.pendingLink) {
			await request.observe?.({
				action: 'ownership_moved',
				flowId: request.pendingLink.flowId,
				provider: request.pendingLink.account.provider,
				critical: true,
				targetUserRef: redactOAuthLinkRef(request.pendingLink.targetUserId),
				accountRef: redactOAuthLinkRef(
					request.pendingLink.account.providerAccountId,
				),
				ownerRef: owner?.id ? redactOAuthLinkRef(owner.id) : undefined,
			})
		}
		throw new OAuthContainmentError(
			`authorized ${authorization.provider} ownership changed before the adapter read`,
		)
	}
	if (request.pendingLink) request.finalOwnershipVerified = true
}

/**
 * Auth-specific adapter wrapper. It leaves non-contained providers alone.
 * Established GitHub and Discord reads stay equal to callback authorization.
 * Logged-out ordinary OAuth may use Auth.js creation and email auto-linking;
 * explicit linking requires the persisted intent path.
 */
export function createOAuthContainmentAdapter<T extends Adapter>(
	adapter: T,
): T {
	const getUserByAccount = adapter.getUserByAccount?.bind(adapter)
	const createUser = adapter.createUser?.bind(adapter)
	const linkAccount = adapter.linkAccount?.bind(adapter)
	const createSession = adapter.createSession?.bind(adapter)
	const getSessionAndUser = adapter.getSessionAndUser?.bind(adapter)

	if (
		!getUserByAccount ||
		!createUser ||
		!linkAccount ||
		!createSession ||
		!getSessionAndUser
	) {
		throw new OAuthContainmentError(
			'required Auth.js adapter methods are missing',
		)
	}

	return {
		...adapter,
		getUserByAccount: async (account) => {
			if (!isConnectableOAuthProvider(account.provider)) {
				return getUserByAccount(account)
			}

			const request = containedRequestFor(account.provider)
			if (!request) {
				throw new OAuthContainmentError(
					`missing or inconsistent request guard for ${account.provider} account read`,
				)
			}

			const owner = await getUserByAccount(account)
			await assertContainedAccountRead(request, account, owner)
			return owner
		},
		createUser: async (user: AdapterUser) => {
			const request = oauthContainmentRequests.getStore()
			if (!request) {
				throw new OAuthContainmentError(
					'missing request guard at createUser boundary',
				)
			}
			if (
				request.requestProvider &&
				isConnectableOAuthProvider(request.requestProvider) &&
				!request.ordinaryOAuthAllowed
			) {
				throw new OAuthContainmentError(
					`${request.requestProvider} createUser is not authorized`,
				)
			}
			return createUser(user)
		},
		linkAccount: async (account: AdapterAccount) => {
			if (isConnectableOAuthProvider(account.provider)) {
				const request = containedRequestFor(account.provider)
				if (request?.ordinaryOAuthAllowed && !request.authorizedAccount) {
					return linkAccount(account)
				}
				await request?.observe?.({
					action: 'mutation_without_consumed_intent',
					flowId: request.pendingLink?.flowId ?? 'olf_missing_intent',
					provider: account.provider,
					critical: true,
					accountRef: redactOAuthLinkRef(account.providerAccountId),
				})
				const authorization = request?.authorizedAccount
				const reason = authorization
					? `${account.provider} linkAccount is not authorized for ${authorization.providerAccountId}`
					: `missing or inconsistent request guard for ${account.provider} linkAccount`
				throw new OAuthContainmentError(reason)
			}
			return linkAccount(account)
		},
		getSessionAndUser: async (sessionToken: string) => {
			const result = await getSessionAndUser(sessionToken)
			if (result && result.session.expires <= new Date()) return null
			return result
		},
		createSession: async (session: AdapterSession) => {
			const request = oauthContainmentRequests.getStore()
			if (
				request?.requestProvider &&
				isConnectableOAuthProvider(request.requestProvider) &&
				!request.ordinaryOAuthAllowed
			) {
				const authorization = request.authorizedAccount
				if (!authorization || authorization.ownerId !== session.userId) {
					throw new OAuthContainmentError(
						`invalid ${request.requestProvider} guard at createSession boundary`,
					)
				}
			}
			return createSession(session)
		},
	} as T
}

/**
 * Containment policy for GitHub and Discord callbacks.
 *
 * Only an exact account row may pass this callback. The authorization is bound
 * to the current Auth.js request. Its guarded adapter then rejects an ownership
 * change before Auth.js can call the provider account mapper or mutate state.
 */
export function createOAuthContainmentSignInCallback({
	getCookieStore,
	findAccountOwner,
	getAuthenticatedSession,
	consumeLinkIntent,
	observe,
}: OAuthContainmentDependencies) {
	return async ({
		account,
	}: {
		account: SignInAccount
	}): Promise<boolean | string> => {
		if (!account?.provider || !isConnectableOAuthProvider(account.provider)) {
			return true
		}

		const cookieStore = await getCookieStore()
		const rawLinkToken = readOAuthLinkIntentToken(cookieStore)
		clearLegacyOAuthLinkCookies(cookieStore)
		clearOAuthLinkIntentCookies(cookieStore)

		if (!account.providerAccountId) return false
		const request = containedRequestFor(account.provider)
		if (!request || request.authorizedAccount) return false

		if (rawLinkToken) {
			const flowId = getOAuthLinkFlowId(rawLinkToken)
			const emit = observe ?? request.observe
			const callbackBase = {
				flowId,
				provider: account.provider,
				accountRef: redactOAuthLinkRef(account.providerAccountId),
			}
			await emit?.({ ...callbackBase, action: 'callback_received' })
			if (
				(account.type !== 'oauth' && account.type !== 'oidc') ||
				!getAuthenticatedSession ||
				!consumeLinkIntent
			) {
				await emit?.({
					...callbackBase,
					action: 'validation_denied',
					reasonClass: 'missing-session',
					result: 'denied',
				})
				await emit?.({
					...callbackBase,
					action: 'flow_completed',
					result: 'denied',
				})
				return '/discord?link=denied'
			}
			const session = await getAuthenticatedSession()
			if (!session) {
				await emit?.({
					...callbackBase,
					action: 'validation_denied',
					reasonClass: 'missing-session',
					result: 'denied',
				})
				await emit?.({
					...callbackBase,
					action: 'flow_completed',
					result: 'denied',
				})
				return '/discord?link=denied'
			}
			const result = await consumeLinkIntent({
				rawToken: rawLinkToken,
				provider: account.provider,
				sessionBinding: hashOAuthLinkSession(session.sessionToken),
				account: account as OAuthLinkAccount,
			})
			if (result.status === 'expired') return '/discord?link=expired'
			if (result.status === 'denied') return '/discord?link=denied'
			if (!('targetUserId' in result)) return '/discord?link=denied'
			if (result.targetUserId !== session.userId) {
				return '/discord?link=denied'
			}

			request.authorizedAccount = {
				provider: account.provider,
				providerAccountId: account.providerAccountId,
				ownerId: result.targetUserId,
			}
			request.pendingLink = {
				account: account as OAuthLinkAccount,
				targetUserId: result.targetUserId,
				linkKind: result.linkKind,
				flowId: result.flowId,
			}
			return true
		}

		try {
			const owner = await findAccountOwner({
				provider: account.provider,
				providerAccountId: account.providerAccountId,
			})
			if (owner) {
				request.authorizedAccount = {
					provider: account.provider,
					providerAccountId: account.providerAccountId,
					ownerId: owner.id,
				}
				return true
			}

			// Logged-out provider sign-in keeps the product's intentional email
			// auto-linking and new-user behavior. An active session must use the
			// explicit persisted intent instead of Auth.js's implicit link branch.
			if (!getAuthenticatedSession) return false
			if (await getAuthenticatedSession()) return false
			request.ordinaryOAuthAllowed = true
			return true
		} catch {
			return false
		}
	}
}

export function takeVerifiedOAuthLink(
	finalUserId: string,
): PendingOAuthLink | null {
	const request = oauthContainmentRequests.getStore()
	const pending = request?.pendingLink
	if (
		!request ||
		!pending ||
		!request.finalOwnershipVerified ||
		pending.targetUserId !== finalUserId
	) {
		return null
	}
	request.pendingLink = null
	return pending
}
