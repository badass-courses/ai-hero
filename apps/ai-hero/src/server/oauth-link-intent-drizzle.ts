import { db } from '@/db'
import { accounts, verificationTokens } from '@/db/schema'
import { and, eq, gt } from 'drizzle-orm'

import {
	createOAuthLinkIntentService,
	parseOAuthLinkIntentIdentifier,
	type OAuthLinkAccount,
	type OAuthLinkIntentRepository,
} from './oauth-link-intent'
import { observeOAuthLinkCanary } from './oauth-link-observability'

function affectedRows(result: unknown) {
	if (!result || typeof result !== 'object') return 0
	const record = result as Record<string, unknown>
	if (typeof record.rowsAffected === 'number') return record.rowsAffected
	if (typeof record.affectedRows === 'number') return record.affectedRows
	return 0
}

type AccountInsert = typeof accounts.$inferInsert

function accountValues(
	account: OAuthLinkAccount,
	userId: string,
): AccountInsert {
	return {
		userId,
		type: account.type,
		provider: account.provider,
		providerAccountId: account.providerAccountId,
		refresh_token: account.refresh_token,
		access_token: account.access_token,
		oauth_token: account.oauth_token,
		oauth_token_secret: account.oauth_token_secret,
		expires_at: account.expires_at,
		token_type: account.token_type,
		scope: account.scope,
		id_token: account.id_token,
		session_state: account.session_state,
		refresh_token_expires_in: account.refresh_token_expires_in,
	}
}

async function findAccountOwner(account: OAuthLinkAccount) {
	return (
		(await db.query.accounts.findFirst({
			where: and(
				eq(accounts.provider, account.provider),
				eq(accounts.providerAccountId, account.providerAccountId),
			),
			columns: { userId: true },
		})) ?? null
	)
}

export const oauthLinkIntentRepository: OAuthLinkIntentRepository = {
	async insert(intent) {
		await db.insert(verificationTokens).values({
			identifier: intent.identifier,
			token: intent.tokenDigest,
			expires: intent.expiresAt,
		})
	},

	async findByTokenDigest(tokenDigest) {
		const row = await db.query.verificationTokens.findFirst({
			where: eq(verificationTokens.token, tokenDigest),
		})
		if (!row) return null
		const parsed = parseOAuthLinkIntentIdentifier(row.identifier)
		if (!parsed) return null
		return {
			...parsed,
			identifier: row.identifier,
			tokenDigest: row.token,
			expiresAt: row.expires,
		}
	},

	async consumeAndLink({ intent, tokenDigest, account, now }) {
		let ownerBeforeConflict: string | null = null
		try {
			const result = await db.transaction(async (tx) => {
				const row = await tx
					.select()
					.from(verificationTokens)
					.where(
						and(
							eq(verificationTokens.identifier, intent.identifier),
							eq(verificationTokens.token, tokenDigest),
						),
					)
					.then((rows) => rows[0] ?? null)
				if (!row) {
					return {
						status: 'denied' as const,
						reasonClass: 'claim-lost' as const,
					}
				}
				if (row.expires <= now) return { status: 'expired' as const }

				const parsed = parseOAuthLinkIntentIdentifier(row.identifier)
				if (
					!parsed ||
					parsed.targetUserId !== intent.targetUserId ||
					parsed.provider !== intent.provider ||
					parsed.sessionBinding !== intent.sessionBinding ||
					parsed.nonce !== intent.nonce ||
					account.provider !== intent.provider
				) {
					return {
						status: 'denied' as const,
						reasonClass: 'claim-lost' as const,
					}
				}

				const existingAccount = await tx
					.select({ userId: accounts.userId })
					.from(accounts)
					.where(
						and(
							eq(accounts.provider, account.provider),
							eq(accounts.providerAccountId, account.providerAccountId),
						),
					)
					.then((rows) => rows[0] ?? null)
				ownerBeforeConflict = existingAccount?.userId ?? null
				if (existingAccount && existingAccount.userId !== intent.targetUserId) {
					return {
						status: 'denied' as const,
						reasonClass: 'cross-user-owned' as const,
					}
				}

				const claim = await tx
					.delete(verificationTokens)
					.where(
						and(
							eq(verificationTokens.identifier, intent.identifier),
							eq(verificationTokens.token, tokenDigest),
							gt(verificationTokens.expires, now),
						),
					)
				if (affectedRows(claim) !== 1) {
					return {
						status: 'denied' as const,
						reasonClass: 'claim-lost' as const,
					}
				}

				const values = accountValues(account, intent.targetUserId)
				if (existingAccount) {
					await tx
						.update(accounts)
						.set(values)
						.where(
							and(
								eq(accounts.provider, account.provider),
								eq(accounts.providerAccountId, account.providerAccountId),
								eq(accounts.userId, intent.targetUserId),
							),
						)
				} else {
					await tx.insert(accounts).values(values)
				}

				const ownerAfter = await tx
					.select({ userId: accounts.userId })
					.from(accounts)
					.where(
						and(
							eq(accounts.provider, account.provider),
							eq(accounts.providerAccountId, account.providerAccountId),
						),
					)
					.then((rows) => rows[0]?.userId ?? null)
				return {
					status: 'linked' as const,
					linkKind: existingAccount
						? ('renewed' as const)
						: ('created' as const),
					consumedIntent: true as const,
					ownershipReadback: {
						beforeOwnerId: existingAccount?.userId ?? null,
						afterOwnerId: ownerAfter,
					},
				}
			})

			if (
				result.status === 'denied' &&
				result.reasonClass === 'cross-user-owned'
			) {
				const ownerAfter = await findAccountOwner(account)
				return {
					...result,
					ownershipReadback: {
						beforeOwnerId: ownerBeforeConflict,
						afterOwnerId: ownerAfter?.userId ?? null,
					},
				}
			}
			return result
		} catch (error) {
			// A concurrent intent may win the provider/account primary key race.
			// Read ownership back and normalize cross-user loss to a denial. Unknown
			// storage failures stay actionable instead of masquerading as policy.
			const ownerAfter = await findAccountOwner(account)
			if (ownerAfter) {
				return {
					status: 'denied' as const,
					reasonClass:
						ownerAfter.userId === intent.targetUserId
							? ('claim-lost' as const)
							: ('cross-user-owned' as const),
					ownershipReadback: {
						beforeOwnerId: ownerBeforeConflict,
						afterOwnerId: ownerAfter.userId,
					},
				}
			}
			throw error
		}
	},
}

export const oauthLinkIntentService = createOAuthLinkIntentService({
	repository: oauthLinkIntentRepository,
	observe: observeOAuthLinkCanary,
})
