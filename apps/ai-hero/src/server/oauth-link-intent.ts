import { createHash, randomBytes } from 'node:crypto'

import type { Account } from '@auth/core/types'
import { createActor, setup } from 'xstate'

import type { ConnectableOAuthProvider } from '@/lib/oauth-link-cookie'

const INTENT_IDENTIFIER_PREFIX = 'oauth-link:v1'
const DEFAULT_INTENT_TTL_MS = 10 * 60 * 1000

type OAuthLinkIntentMachineContext = {
	expiresAt: number
}

type OAuthLinkIntentMachineEvent =
	| { type: 'CONSUME'; now: number }
	| { type: 'COMMIT' }
	| { type: 'EXPIRE' }
	| { type: 'DENY' }

export const oauthLinkIntentMachine = setup({
	types: {
		context: {} as OAuthLinkIntentMachineContext,
		events: {} as OAuthLinkIntentMachineEvent,
		input: {} as OAuthLinkIntentMachineContext,
	},
	guards: {
		isExpired: ({ context, event }) =>
			event.type === 'CONSUME' && event.now >= context.expiresAt,
	},
}).createMachine({
	id: 'oauthLinkIntent',
	initial: 'issued',
	context: ({ input }) => input,
	states: {
		issued: {
			on: {
				CONSUME: [
					{ guard: 'isExpired', target: 'expired' },
					{ target: 'consuming' },
				],
				DENY: 'denied',
			},
		},
		consuming: {
			on: {
				COMMIT: 'consumed',
				EXPIRE: 'expired',
				DENY: 'denied',
			},
		},
		consumed: { type: 'final' },
		expired: { type: 'final' },
		denied: { type: 'final' },
	},
})

export type StoredOAuthLinkIntent = {
	identifier: string
	tokenDigest: string
	targetUserId: string
	provider: ConnectableOAuthProvider
	sessionBinding: string
	nonce: string
	expiresAt: Date
}

export type OAuthLinkAccount = {
	userId?: string
	provider: ConnectableOAuthProvider
	providerAccountId: string
	type: 'oauth' | 'oidc'
	refresh_token?: Account['refresh_token']
	access_token?: Account['access_token']
	expires_at?: Account['expires_at']
	token_type?: Account['token_type']
	scope?: Account['scope']
	id_token?: Account['id_token']
	session_state?: string
	oauth_token?: string
	oauth_token_secret?: string
	refresh_token_expires_in?: number
}

export type OAuthLinkDenialReason =
	| 'token-not-found'
	| 'intent-expired'
	| 'provider-mismatch'
	| 'session-mismatch'
	| 'cross-user-owned'
	| 'claim-lost'

type OwnershipReadback = {
	beforeOwnerId: string | null
	afterOwnerId: string | null
}

export type OAuthLinkIntentRepositoryResult =
	| {
			status: 'linked'
			linkKind: 'created' | 'renewed'
			consumedIntent: true
			ownershipReadback: OwnershipReadback
	  }
	| { status: 'expired' }
	| {
			status: 'denied'
			reasonClass: 'cross-user-owned' | 'claim-lost'
			ownershipReadback?: OwnershipReadback
	  }

export type OAuthLinkIntentRepository = {
	insert(intent: StoredOAuthLinkIntent): Promise<void>
	findByTokenDigest(tokenDigest: string): Promise<StoredOAuthLinkIntent | null>
	consumeAndLink(input: {
		intent: StoredOAuthLinkIntent
		tokenDigest: string
		account: OAuthLinkAccount
		now: Date
	}): Promise<OAuthLinkIntentRepositoryResult>
}

export type OAuthLinkCanaryAction =
	| 'intent_issued'
	| 'callback_received'
	| 'validation_allowed'
	| 'validation_denied'
	| 'consume_result'
	| 'ownership_before'
	| 'link_result'
	| 'ownership_after'
	| 'role_sync_trigger'
	| 'flow_completed'
	| 'mutation_without_consumed_intent'
	| 'ownership_moved'

export type OAuthLinkCanaryEvent = {
	action: OAuthLinkCanaryAction
	flowId: string
	provider: ConnectableOAuthProvider
	intentRef?: string
	targetUserRef?: string
	sessionRef?: string
	accountRef?: string
	ownerRef?: string
	expectedOwnerRef?: string
	ownerUnchanged?: boolean
	reasonClass?: OAuthLinkDenialReason | 'missing-session'
	result?: 'allowed' | 'denied' | 'expired' | 'consumed' | 'linked' | 'renewed'
	expiresAt?: string
	critical?: boolean
}

type OAuthLinkIntentServiceDependencies = {
	repository: OAuthLinkIntentRepository
	now?: () => Date
	newToken?: () => string
	newNonce?: () => string
	ttlMs?: number
	observe?: (event: OAuthLinkCanaryEvent) => void | Promise<void>
}

export function redactOAuthLinkRef(value: string) {
	return createHash('sha256').update(value).digest('base64url').slice(0, 22)
}

export function hashOAuthLinkSession(sessionToken: string) {
	return createHash('sha256').update(sessionToken).digest('base64url')
}

export function hashOAuthLinkToken(rawToken: string) {
	return createHash('sha256').update(rawToken).digest('base64url')
}

export function getOAuthLinkFlowId(rawToken: string) {
	return `olf_${redactOAuthLinkRef(hashOAuthLinkToken(rawToken))}`
}

function getOAuthLinkFlowIdFromDigest(tokenDigest: string) {
	return `olf_${redactOAuthLinkRef(tokenDigest)}`
}

function randomOpaqueValue(bytes: number) {
	return randomBytes(bytes).toString('base64url')
}

export function createOAuthLinkIntentIdentifier({
	targetUserId,
	provider,
	sessionBinding,
	nonce,
}: Pick<
	StoredOAuthLinkIntent,
	'targetUserId' | 'provider' | 'sessionBinding' | 'nonce'
>) {
	if (
		[targetUserId, provider, sessionBinding, nonce].some((value) =>
			value.includes('|'),
		)
	) {
		throw new Error('OAuth link intent fields contain an invalid delimiter')
	}
	return [
		INTENT_IDENTIFIER_PREFIX,
		provider,
		targetUserId,
		sessionBinding,
		nonce,
	].join('|')
}

export function parseOAuthLinkIntentIdentifier(
	identifier: string,
): Omit<
	StoredOAuthLinkIntent,
	'identifier' | 'tokenDigest' | 'expiresAt'
> | null {
	const [prefix, provider, targetUserId, sessionBinding, nonce, extra] =
		identifier.split('|')
	if (
		prefix !== INTENT_IDENTIFIER_PREFIX ||
		extra !== undefined ||
		(provider !== 'discord' && provider !== 'github') ||
		!targetUserId ||
		!sessionBinding ||
		!nonce
	) {
		return null
	}
	return { provider, targetUserId, sessionBinding, nonce }
}

export function createOAuthLinkIntentService({
	repository,
	now = () => new Date(),
	newToken = () => randomOpaqueValue(32),
	newNonce = () => randomOpaqueValue(18),
	ttlMs = DEFAULT_INTENT_TTL_MS,
	observe = () => undefined,
}: OAuthLinkIntentServiceDependencies) {
	const emit = async (event: OAuthLinkCanaryEvent) => {
		try {
			await observe(event)
		} catch {
			// Canary telemetry must never become an auth decision or test backdoor.
		}
	}

	const emitOwnership = async ({
		flowId,
		provider,
		intent,
		account,
		readback,
	}: {
		flowId: string
		provider: ConnectableOAuthProvider
		intent: StoredOAuthLinkIntent
		account: OAuthLinkAccount
		readback: OwnershipReadback
	}) => {
		const base = {
			flowId,
			provider,
			intentRef: redactOAuthLinkRef(intent.tokenDigest),
			targetUserRef: redactOAuthLinkRef(intent.targetUserId),
			accountRef: redactOAuthLinkRef(account.providerAccountId),
			expectedOwnerRef: redactOAuthLinkRef(intent.targetUserId),
		}
		await emit({
			...base,
			action: 'ownership_before',
			ownerRef: readback.beforeOwnerId
				? redactOAuthLinkRef(readback.beforeOwnerId)
				: undefined,
		})
		await emit({
			...base,
			action: 'ownership_after',
			ownerRef: readback.afterOwnerId
				? redactOAuthLinkRef(readback.afterOwnerId)
				: undefined,
			ownerUnchanged: readback.beforeOwnerId === readback.afterOwnerId,
		})
	}

	const emitDenied = async ({
		flowId,
		provider,
		reasonClass,
		account,
		intent,
		ownershipReadback,
		result = 'denied',
	}: {
		flowId: string
		provider: ConnectableOAuthProvider
		reasonClass: OAuthLinkDenialReason
		account: OAuthLinkAccount
		intent?: StoredOAuthLinkIntent
		ownershipReadback?: OwnershipReadback
		result?: 'denied' | 'expired'
	}) => {
		const base = {
			flowId,
			provider,
			reasonClass,
			accountRef: redactOAuthLinkRef(account.providerAccountId),
			...(intent && {
				intentRef: redactOAuthLinkRef(intent.tokenDigest),
				targetUserRef: redactOAuthLinkRef(intent.targetUserId),
			}),
		}
		await emit({ ...base, action: 'validation_denied', result })
		if (intent && ownershipReadback) {
			await emitOwnership({
				flowId,
				provider,
				intent,
				account,
				readback: ownershipReadback,
			})
			if (
				reasonClass === 'cross-user-owned' &&
				ownershipReadback.beforeOwnerId !== ownershipReadback.afterOwnerId
			) {
				await emit({
					...base,
					action: 'ownership_moved',
					critical: true,
				})
			}
		}
		await emit({ ...base, action: 'consume_result', result })
		await emit({ ...base, action: 'link_result', result: 'denied' })
		await emit({ ...base, action: 'flow_completed', result })
	}

	return {
		async issue({
			targetUserId,
			provider,
			sessionBinding,
		}: {
			targetUserId: string
			provider: ConnectableOAuthProvider
			sessionBinding: string
		}) {
			const rawToken = newToken()
			const nonce = newNonce()
			const expiresAt = new Date(now().getTime() + ttlMs)
			const intent: StoredOAuthLinkIntent = {
				identifier: createOAuthLinkIntentIdentifier({
					targetUserId,
					provider,
					sessionBinding,
					nonce,
				}),
				tokenDigest: hashOAuthLinkToken(rawToken),
				targetUserId,
				provider,
				sessionBinding,
				nonce,
				expiresAt,
			}
			await repository.insert(intent)
			const flowId = getOAuthLinkFlowIdFromDigest(intent.tokenDigest)
			await emit({
				action: 'intent_issued',
				flowId,
				provider,
				intentRef: redactOAuthLinkRef(intent.tokenDigest),
				targetUserRef: redactOAuthLinkRef(targetUserId),
				sessionRef: redactOAuthLinkRef(sessionBinding),
				expiresAt: expiresAt.toISOString(),
			})
			return { rawToken, expiresAt, flowId }
		},

		async consume({
			rawToken,
			provider,
			sessionBinding,
			account,
		}: {
			rawToken: string
			provider: ConnectableOAuthProvider
			sessionBinding: string
			account: OAuthLinkAccount
		}): Promise<
			| {
					status: 'linked'
					targetUserId: string
					linkKind: 'created' | 'renewed'
					flowId: string
			  }
			| { status: 'expired' }
			| { status: 'denied'; reasonClass?: OAuthLinkDenialReason }
		> {
			const tokenDigest = hashOAuthLinkToken(rawToken)
			const flowId = getOAuthLinkFlowIdFromDigest(tokenDigest)
			const intent = await repository.findByTokenDigest(tokenDigest)
			if (!intent) {
				await emitDenied({
					flowId,
					provider,
					reasonClass: 'token-not-found',
					account,
				})
				return { status: 'denied' }
			}

			const actor = createActor(oauthLinkIntentMachine, {
				input: { expiresAt: intent.expiresAt.getTime() },
			}).start()
			const consumedAt = now()
			actor.send({ type: 'CONSUME', now: consumedAt.getTime() })
			if (actor.getSnapshot().matches('expired')) {
				await emitDenied({
					flowId,
					provider,
					reasonClass: 'intent-expired',
					account,
					intent,
					result: 'expired',
				})
				return { status: 'expired' }
			}
			if (intent.provider !== provider || account.provider !== provider) {
				actor.send({ type: 'DENY' })
				await emitDenied({
					flowId,
					provider,
					reasonClass: 'provider-mismatch',
					account,
					intent,
				})
				return { status: 'denied' }
			}
			if (intent.sessionBinding !== sessionBinding) {
				actor.send({ type: 'DENY' })
				await emitDenied({
					flowId,
					provider,
					reasonClass: 'session-mismatch',
					account,
					intent,
				})
				return { status: 'denied' }
			}

			await emit({
				action: 'validation_allowed',
				flowId,
				provider,
				result: 'allowed',
				intentRef: redactOAuthLinkRef(intent.tokenDigest),
				targetUserRef: redactOAuthLinkRef(intent.targetUserId),
				sessionRef: redactOAuthLinkRef(sessionBinding),
				accountRef: redactOAuthLinkRef(account.providerAccountId),
			})

			const repositoryResult = await repository.consumeAndLink({
				intent,
				tokenDigest,
				account,
				now: consumedAt,
			})
			if (repositoryResult.status === 'expired') {
				actor.send({ type: 'EXPIRE' })
				await emitDenied({
					flowId,
					provider,
					reasonClass: 'intent-expired',
					account,
					intent,
					result: 'expired',
				})
				return { status: 'expired' }
			}
			if (repositoryResult.status === 'denied') {
				actor.send({ type: 'DENY' })
				await emitDenied({
					flowId,
					provider,
					reasonClass: repositoryResult.reasonClass,
					account,
					intent,
					ownershipReadback: repositoryResult.ownershipReadback,
				})
				return {
					status: 'denied',
					reasonClass: repositoryResult.reasonClass,
				}
			}

			if (repositoryResult.consumedIntent !== true) {
				await emit({
					action: 'mutation_without_consumed_intent',
					flowId,
					provider,
					critical: true,
					intentRef: redactOAuthLinkRef(intent.tokenDigest),
					accountRef: redactOAuthLinkRef(account.providerAccountId),
				})
				return { status: 'denied' }
			}

			actor.send({ type: 'COMMIT' })
			await emitOwnership({
				flowId,
				provider,
				intent,
				account,
				readback: repositoryResult.ownershipReadback,
			})
			const ownerAfter = repositoryResult.ownershipReadback.afterOwnerId
			if (ownerAfter !== intent.targetUserId) {
				await emit({
					action: 'ownership_moved',
					flowId,
					provider,
					critical: true,
					intentRef: redactOAuthLinkRef(intent.tokenDigest),
					targetUserRef: redactOAuthLinkRef(intent.targetUserId),
					accountRef: redactOAuthLinkRef(account.providerAccountId),
					ownerRef: ownerAfter ? redactOAuthLinkRef(ownerAfter) : undefined,
				})
				return { status: 'denied' }
			}

			const common = {
				flowId,
				provider,
				intentRef: redactOAuthLinkRef(intent.tokenDigest),
				targetUserRef: redactOAuthLinkRef(intent.targetUserId),
				accountRef: redactOAuthLinkRef(account.providerAccountId),
			}
			await emit({ ...common, action: 'consume_result', result: 'consumed' })
			await emit({
				...common,
				action: 'link_result',
				result: repositoryResult.linkKind === 'created' ? 'linked' : 'renewed',
			})
			return {
				status: 'linked',
				targetUserId: intent.targetUserId,
				linkKind: repositoryResult.linkKind,
				flowId,
			}
		},
	}
}
