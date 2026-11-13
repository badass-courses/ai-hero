import { UserSchema } from '@/ability'
import { db } from '@/db'
import { accounts, entitlements, entitlementTypes, users } from '@/db/schema'
import { env } from '@/env.mjs'
import { OAUTH_PROVIDER_ACCOUNT_LINKED_EVENT } from '@/inngest/events/oauth-provider-account-linked'
import { inngest } from '@/inngest/inngest.server'
import { DiscordError, DiscordMember } from '@/lib/discord'
import { fetchAsDiscordBot, fetchJsonAsDiscordBot } from '@/lib/discord-query'
import { discordRoleClient } from '@/lib/discord-utils'
import { getSubscriptionStatus } from '@/lib/subscriptions'
import { redactOAuthLinkRef } from '@/server/oauth-link-intent'
import { observeOAuthLinkCanary } from '@/server/oauth-link-observability'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import { runDiscordProviderBoundary } from './discord-account-linked-boundary'

/** Role IDs named by the entitlements that the member doesn't hold yet. */
export function missingDiscordRoleIds(
	currentRoles: string[],
	entitlementRows: { metadata?: unknown }[],
): string[] {
	const wanted = entitlementRows
		.map(
			(row) =>
				(row.metadata as { discordRoleId?: unknown } | null | undefined)
					?.discordRoleId,
		)
		.filter((id): id is string => typeof id === 'string' && id.length > 0)
	return [...new Set(wanted)].filter((id) => !currentRoles.includes(id))
}

export const discordAccountLinked = inngest.createFunction(
	{
		id: `discord-account-linked`,
		name: 'Discord Account Linked',
	},
	{
		event: OAUTH_PROVIDER_ACCOUNT_LINKED_EVENT,
		if: 'event.data.account.provider == "discord"',
	},
	async ({ event, step }) => {
		const { account } = event.data

		const user = await step.run('get user', async () => {
			return await db.query.users.findFirst({
				where: eq(users.id, event.user.id),
				with: {
					purchases: true,
				},
			})
		})

		if (!user) throw new Error('No user found')

		const findCurrentAccount = async () => {
			const current = await db.query.accounts.findFirst({
				where: and(
					eq(accounts.userId, event.user.id),
					eq(accounts.provider, 'discord'),
					eq(accounts.providerAccountId, account.providerAccountId),
				),
			})
			return current
				? {
						userId: current.userId,
						providerAccountId: current.providerAccountId,
						accessToken: current.access_token,
					}
				: null
		}
		const recordOwnershipMoved = async () => {
			if (event.data.flowId) {
				await observeOAuthLinkCanary({
					action: 'ownership_moved',
					flowId: event.data.flowId,
					provider: 'discord',
					critical: true,
					targetUserRef: redactOAuthLinkRef(event.user.id),
					accountRef: redactOAuthLinkRef(account.providerAccountId),
				})
			}
		}

		const discordUserBoundary = await step.run(
			'get discord user with current ownership',
			async () =>
				runDiscordProviderBoundary({
					eventUserId: event.user.id,
					eventProviderAccountId: account.providerAccountId,
					findCurrentAccount,
					onDenied: recordOwnershipMoved,
					callProvider: async (accessToken) => {
						const userUrl = new URL('https://discord.com/api/users/@me')
						const userRes = await fetch(userUrl.toString(), {
							headers: { authorization: `Bearer ${accessToken}` },
						})
						return userRes.json()
					},
				}),
		)
		if (discordUserBoundary.status === 'denied') {
			return 'discord ownership changed; role sync skipped'
		}
		const discordUser = discordUserBoundary.value

		const addMemberBoundary = await step.run(
			'add user with current ownership',
			async () =>
				runDiscordProviderBoundary({
					eventUserId: event.user.id,
					eventProviderAccountId: account.providerAccountId,
					findCurrentAccount,
					onDenied: recordOwnershipMoved,
					callProvider: (accessToken) =>
						fetchAsDiscordBot(
							`guilds/${env.DISCORD_GUILD_ID}/members/${discordUser.id}`,
							{
								method: 'PUT',
								body: JSON.stringify({ access_token: accessToken }),
								headers: { 'Content-Type': 'application/json' },
							},
						),
				}),
		)
		if (addMemberBoundary.status === 'denied') {
			return 'discord ownership changed; role sync skipped'
		}

		await step.sleep('give discord a moment', '10s')

		const discordAccount = await step.run(
			'check if discord is connected',
			async () => {
				return db.query.accounts.findFirst({
					where: and(
						eq(accounts.userId, user.id),
						eq(accounts.provider, 'discord'),
						eq(accounts.providerAccountId, account.providerAccountId),
					),
				})
			},
		)

		if (discordAccount) {
			let discordMember = await step.run('get discord member', async () => {
				return await fetchJsonAsDiscordBot<DiscordMember | DiscordError>(
					`guilds/${env.DISCORD_GUILD_ID}/members/${discordAccount.providerAccountId}`,
				)
			})

			// Cohort and workshop roles both come from entitlements. Linking used to
			// read only cohort ones, so anyone who linked Discord after buying a
			// workshop never got its role. Deleted (refunded) entitlements are skipped.
			const discordRoleEntitlementTypeIds = await step.run(
				`get discord role entitlement types`,
				async () => {
					const types = await db.query.entitlementTypes.findMany({
						where: inArray(entitlementTypes.name, [
							'cohort_discord_role',
							'workshop_discord_role',
						]),
					})
					return types.map((type) => type.id)
				},
			)

			const userDiscordEntitlements = await step.run(
				'get user discord entitlements',
				async () => {
					if (discordRoleEntitlementTypeIds.length === 0) {
						return []
					}

					return db.query.entitlements.findMany({
						where: and(
							eq(entitlements.userId, user.id),
							inArray(
								entitlements.entitlementType,
								discordRoleEntitlementTypeIds,
							),
							isNull(entitlements.deletedAt),
						),
					})
				},
			)

			const roleUpdateBoundary = await step.run(
				'update roles with current ownership',
				async () =>
					runDiscordProviderBoundary({
						eventUserId: event.user.id,
						eventProviderAccountId: account.providerAccountId,
						findCurrentAccount,
						onDenied: recordOwnershipMoved,
						callProvider: async () => {
							if ('user' in discordMember) {
								const missing = missingDiscordRoleIds(
									discordMember.roles,
									userDiscordEntitlements,
								)
								// One role at a time: a concurrent purchase grant can't be
								// overwritten, and a failure throws so the step retries.
								for (const roleId of missing)
									await discordRoleClient.addRole(
										account.providerAccountId,
										roleId,
									)
								return { added: missing.length }
							}
							return null
						},
					}),
			)
			if (roleUpdateBoundary.status === 'denied') {
				return 'discord ownership changed; role sync skipped'
			}

			discordMember = await step.run('reload discord member', async () => {
				return await fetchJsonAsDiscordBot<DiscordMember | DiscordError>(
					`guilds/${env.DISCORD_GUILD_ID}/members/${discordAccount.providerAccountId}`,
				)
			})

			return {
				account,
				user: event.user,
				discordMember,
			}
		}

		return 'no discord account found for user'
	},
)
