import { db } from '@/db'
import { accounts } from '@/db/schema'
import { env } from '@/env.mjs'
import { refreshDiscordAccessToken } from '@/server/discord-token-refresh'
import {
	claimDiscordRefresh,
	getDiscordRefreshClaimExpiresAt,
	isDiscordTokenExpired,
	persistDiscordRefreshResult,
	type DiscordAccountCredentials,
	type DiscordCredentialUpdate,
} from '@/server/discord-token-refresh-persistence'
import { log, serializeError } from '@/server/logger'
import { isInProxyAuthContext } from '@/server/proxy-auth-context'
import { bustSessionAccessForUser } from '@/server/session-access-runtime'
import { and, eq, isNull } from 'drizzle-orm'
import { after } from 'next/server'

/**
 * Refresh an expired Discord token for the user. Reads the account fresh, so
 * a cached expiry only decides whether to look. The claim protocol keeps
 * concurrent callers from refreshing twice.
 */
export async function refreshExpiredDiscordToken(userId: string) {
	const discordAccount = await db.query.accounts.findFirst({
		where: and(eq(accounts.userId, userId), eq(accounts.provider, 'discord')),
	})

	const nowMs = Date.now()
	if (
		!discordAccount ||
		!isDiscordTokenExpired(discordAccount.expires_at ?? null, nowMs)
	)
		return

	const claimExpiresAt = getDiscordRefreshClaimExpiresAt(nowMs)
	const expectedCredentials: DiscordAccountCredentials = {
		accessToken: discordAccount.access_token,
		refreshToken: discordAccount.refresh_token,
		expiresAt: discordAccount.expires_at,
	}
	const accountIdentityCondition = and(
		eq(accounts.providerAccountId, discordAccount.providerAccountId),
		eq(accounts.provider, 'discord'),
		eq(accounts.userId, userId),
	)
	const expectedRefreshTokenCondition =
		expectedCredentials.refreshToken !== null
			? eq(accounts.refresh_token, expectedCredentials.refreshToken)
			: isNull(accounts.refresh_token)
	const expectedExpiryCondition =
		expectedCredentials.expiresAt !== null
			? eq(accounts.expires_at, expectedCredentials.expiresAt)
			: isNull(accounts.expires_at)
	const readCredentials = async () => {
		const current = await db.query.accounts.findFirst({
			where: accountIdentityCondition,
			columns: {
				access_token: true,
				refresh_token: true,
				expires_at: true,
			},
		})
		return current
			? {
					accessToken: current.access_token,
					refreshToken: current.refresh_token,
					expiresAt: current.expires_at,
				}
			: null
	}
	const toDatabaseUpdate = (update: DiscordCredentialUpdate) => ({
		...(update.accessToken !== undefined
			? { access_token: update.accessToken }
			: {}),
		...(update.refreshToken !== undefined
			? { refresh_token: update.refreshToken }
			: {}),
		...(update.expiresAt !== undefined ? { expires_at: update.expiresAt } : {}),
	})

	const claim = await claimDiscordRefresh({
		expected: expectedCredentials,
		claimExpiresAt,
		claim: async () => {
			const result = await db
				.update(accounts)
				.set({ expires_at: claimExpiresAt })
				.where(
					and(
						accountIdentityCondition,
						expectedRefreshTokenCondition,
						expectedExpiryCondition,
					),
				)
			return result.rowsAffected
		},
		read: readCredentials,
	})
	if (claim.status === 'stale-result') {
		void log.info('auth.discord.token-refresh', {
			provider: 'discord',
			action: 'stale-result',
			providerOutcome: 'not-requested',
			databaseOutcome: claim.databaseOutcome,
		})
		return
	}

	void log.info('auth.discord.token-refresh', {
		provider: 'discord',
		action: 'started',
		databaseOutcome: claim.databaseOutcome,
	})
	const refreshedToken = await refreshDiscordAccessToken({
		clientId: env.DISCORD_CLIENT_ID,
		clientSecret: env.DISCORD_CLIENT_SECRET,
		refreshToken: discordAccount.refresh_token,
	})
	const persistence = await persistDiscordRefreshResult({
		result: refreshedToken,
		expected: expectedCredentials,
		nowSeconds: Math.floor(Date.now() / 1000),
		writeClaimed: async (update) => {
			const result = await db
				.update(accounts)
				.set(toDatabaseUpdate(update))
				.where(
					and(
						accountIdentityCondition,
						expectedRefreshTokenCondition,
						eq(accounts.expires_at, claimExpiresAt),
					),
				)
			return result.rowsAffected
		},
		recoverCleared: async (update) => {
			const result = await db
				.update(accounts)
				.set(toDatabaseUpdate(update))
				.where(
					and(
						accountIdentityCondition,
						isNull(accounts.access_token),
						isNull(accounts.refresh_token),
						isNull(accounts.expires_at),
					),
				)
			return result.rowsAffected
		},
		read: readCredentials,
	})

	const logFields = {
		provider: 'discord',
		action: persistence.action,
		providerOutcome: persistence.providerOutcome,
		databaseOutcome: persistence.databaseOutcome,
		attempts: refreshedToken.attempts,
	}
	if (persistence.action === 'failed') {
		void log.error('auth.discord.token-refresh', {
			...logFields,
			reasonCode:
				refreshedToken.status === 'failed'
					? refreshedToken.reasonCode
					: 'provider-rejected',
			lastStatus:
				refreshedToken.status === 'failed' ? refreshedToken.lastStatus : null,
		})
	} else {
		void log.info('auth.discord.token-refresh', {
			...logFields,
			...(refreshedToken.status !== 'refreshed'
				? { reasonCode: refreshedToken.reasonCode }
				: {}),
			...(refreshedToken.status === 'failed'
				? { lastStatus: refreshedToken.lastStatus }
				: {}),
		})
	}
}

type DiscordRefreshDependencies = {
	refresh: (userId: string) => Promise<void>
	bustUser: (userId: string) => Promise<void>
	isDeferred: () => boolean
	schedule: (task: () => Promise<void>) => void
	onError: (error: unknown) => void
}

/**
 * Session-callback hook for an expired cached Discord expiry. Refreshes at
 * most once at a time per user in this process, then busts the user's session
 * access cache so the next read sees the new expiry. Never throws.
 */
export function createExpiredDiscordTokenHandler({
	refresh,
	bustUser,
	isDeferred,
	schedule,
	onError,
}: DiscordRefreshDependencies) {
	const inFlight = new Map<string, Promise<void>>()

	const start = (userId: string) => {
		const current = inFlight.get(userId)
		if (current) return current
		const task = refresh(userId)
			.catch(onError)
			.then(() => bustUser(userId))
			.catch(onError)
			.finally(() => inFlight.delete(userId))
		inFlight.set(userId, task)
		return task
	}

	return async (userId: string) => {
		if (!isDeferred()) return start(userId)
		try {
			schedule(() => start(userId))
		} catch {
			// Outside a request scope `after()` throws. Still never block.
			void start(userId)
		}
	}
}

export const handleExpiredDiscordToken = createExpiredDiscordTokenHandler({
	refresh: refreshExpiredDiscordToken,
	bustUser: bustSessionAccessForUser,
	isDeferred: isInProxyAuthContext,
	schedule: (task) => after(task),
	onError: (error) => {
		void log.error('auth.discord.token-refresh', {
			provider: 'discord',
			action: 'failed',
			reasonCode: 'unexpected-error',
			error: serializeError(error),
		})
	},
})
