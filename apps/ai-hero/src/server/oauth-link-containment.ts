import { AsyncLocalStorage } from 'node:async_hooks'

import {
	clearLegacyOAuthLinkCookies,
	isConnectableOAuthProvider,
	type ConnectableOAuthProvider,
} from '@/lib/oauth-link-cookie'

import type {
	Adapter,
	AdapterAccount,
	AdapterSession,
	AdapterUser,
} from '@auth/core/adapters'

type SignInAccount = {
	provider?: string | null
	providerAccountId?: string | null
} | null

type CookieDeleter = Parameters<typeof clearLegacyOAuthLinkCookies>[0]

type AccountOwner = { id: string } | null

type OAuthContainmentDependencies = {
	getCookieStore: () => CookieDeleter | Promise<CookieDeleter>
	findAccountOwner: (account: {
		provider: ConnectableOAuthProvider
		providerAccountId: string
	}) => AccountOwner | Promise<AccountOwner>
}

type ContainedAccountAuthorization = {
	provider: ConnectableOAuthProvider
	providerAccountId: string
	ownerId: string
}

type OAuthContainmentRequest = {
	requestProvider: string | null
	authorizedAccount: ContainedAccountAuthorization | null
}

const oauthContainmentRequests = new AsyncLocalStorage<OAuthContainmentRequest>()

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
): T {
	return oauthContainmentRequests.run(
		{
			requestProvider: getCallbackProvider(request),
			authorizedAccount: null,
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

function assertContainedAccountRead(
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
		throw new OAuthContainmentError(
			`authorized ${authorization.provider} ownership changed before the adapter read`,
		)
	}
}

/**
 * Auth-specific adapter wrapper. It leaves non-contained providers alone.
 * GitHub and Discord reads must stay equal to the account authorized by the
 * callback, and their create/link boundaries fail closed.
 */
export function createOAuthContainmentAdapter<T extends Adapter>(adapter: T): T {
	const getUserByAccount = adapter.getUserByAccount?.bind(adapter)
	const createUser = adapter.createUser?.bind(adapter)
	const linkAccount = adapter.linkAccount?.bind(adapter)
	const createSession = adapter.createSession?.bind(adapter)

	if (!getUserByAccount || !createUser || !linkAccount || !createSession) {
		throw new OAuthContainmentError('required Auth.js adapter methods are missing')
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
			assertContainedAccountRead(request, account, owner)
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
				isConnectableOAuthProvider(request.requestProvider)
			) {
				throw new OAuthContainmentError(
					`${request.requestProvider} createUser is disabled`,
				)
			}
			return createUser(user)
		},
		linkAccount: async (account: AdapterAccount) => {
			if (isConnectableOAuthProvider(account.provider)) {
				const request = containedRequestFor(account.provider)
				const authorization = request?.authorizedAccount
				const reason = authorization
					? `${account.provider} linkAccount is disabled for ${authorization.providerAccountId}`
					: `missing or inconsistent request guard for ${account.provider} linkAccount`
				throw new OAuthContainmentError(reason)
			}
			return linkAccount(account)
		},
		createSession: async (session: AdapterSession) => {
			const request = oauthContainmentRequests.getStore()
			if (
				request?.requestProvider &&
				isConnectableOAuthProvider(request.requestProvider)
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
}: OAuthContainmentDependencies) {
	return async ({ account }: { account: SignInAccount }): Promise<boolean> => {
		if (!account?.provider || !isConnectableOAuthProvider(account.provider)) {
			return true
		}

		clearLegacyOAuthLinkCookies(await getCookieStore())

		if (!account.providerAccountId) return false
		const request = containedRequestFor(account.provider)
		if (!request || request.authorizedAccount) return false

		try {
			const owner = await findAccountOwner({
				provider: account.provider,
				providerAccountId: account.providerAccountId,
			})
			if (!owner) return false

			request.authorizedAccount = {
				provider: account.provider,
				providerAccountId: account.providerAccountId,
				ownerId: owner.id,
			}
			return true
		} catch {
			return false
		}
	}
}

/**
 * GitHub and Discord link events are unreachable while their adapter mutation
 * boundary is closed. Crash loudly if that invariant changes.
 */
export function assertOAuthLinkAccountEventUnreachableDuringContainment({
	account,
}: {
	account: { provider?: string | null }
}): never {
	throw new Error(
		`Auth.js linkAccount event reached during OAuth containment (${account.provider ?? 'unknown'})`,
	)
}
