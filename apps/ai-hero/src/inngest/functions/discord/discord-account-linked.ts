import { UserSchema } from '@/ability'
import { db } from '@/db'
import { accounts, entitlements, entitlementTypes, users } from '@/db/schema'
import { env } from '@/env.mjs'
import { OAUTH_PROVIDER_ACCOUNT_LINKED_EVENT } from '@/inngest/events/oauth-provider-account-linked'
import { inngest } from '@/inngest/inngest.server'
import { DiscordError, DiscordMember } from '@/lib/discord'
import { fetchAsDiscordBot, fetchJsonAsDiscordBot } from '@/lib/discord-query'
import { getSubscriptionStatus } from '@/lib/subscriptions'
import { redactOAuthLinkRef } from '@/server/oauth-link-intent'
import { observeOAuthLinkCanary } from '@/server/oauth-link-observability'
import { and, eq } from 'drizzle-orm'

import { runDiscordProviderBoundary } from './discord-account-linked-boundary'

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

			const cohortDiscordRoleEntitlementType = await step.run(
				`get cohort discord role entitlement type`,
				async () => {
					return await db.query.entitlementTypes.findFirst({
						where: eq(entitlementTypes.name, 'cohort_discord_role'),
					})
				},
			)

			const userDiscordEntitlements = await step.run(
				'get user discord entitlements',
				async () => {
					if (!cohortDiscordRoleEntitlementType) {
						return []
					}

					return db.query.entitlements.findMany({
						where: and(
							eq(entitlements.userId, user.id),
							eq(
								entitlements.entitlementType,
								cohortDiscordRoleEntitlementType.id,
							),
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
								const discordIds = userDiscordEntitlements.map(
									(entitlement) => entitlement.metadata?.discordRoleId,
								)
								const roles = Array.from(
									new Set([...discordMember.roles, ...discordIds]),
								)
								return fetchAsDiscordBot(
									`guilds/${env.DISCORD_GUILD_ID}/members/${account.providerAccountId}`,
									{
										method: 'PATCH',
										body: JSON.stringify({ roles }),
										headers: {
											'Content-Type': 'application/json',
										},
									},
								)
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
