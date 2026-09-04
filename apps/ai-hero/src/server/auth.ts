import { cache } from 'react'
import { cookies } from 'next/headers'
import { getAbility, UserSchema } from '@/ability'
import { emailProvider } from '@/coursebuilder/email-provider'
import { courseBuilderAdapter, db } from '@/db'
import { accounts, entitlements, organizationMemberships } from '@/db/schema'
import { env } from '@/env.mjs'
import { clearLegacyOAuthLinkCookies } from '@/lib/oauth-link-cookie'
import {
	OAUTH_PROVIDER_ACCOUNT_LINKED_EVENT,
	toOAuthProviderAccountReference,
} from '@/inngest/events/oauth-provider-account-linked'
import { USER_CREATED_EVENT } from '@/inngest/events/user-created'
import { inngest } from '@/inngest/inngest.server'
import { acceptBillingAdminInvitations } from '@/lib/team-manager-invitations'
import { authLogger } from '@/server/auth-logger'
import { createPostSignInInvitationHandler } from '@/server/auth-post-sign-in'
import { refreshDiscordAccessToken } from '@/server/discord-token-refresh'
import {
	claimDiscordRefresh,
	getDiscordRefreshClaimExpiresAt,
	isDiscordTokenExpired,
	persistDiscordRefreshResult,
	type DiscordAccountCredentials,
	type DiscordCredentialUpdate,
} from '@/server/discord-token-refresh-persistence'
import { log } from '@/server/logger'
import {
	createOAuthContainmentAdapter,
	createOAuthContainmentSignInCallback,
	runWithOAuthContainmentRequest,
	takeVerifiedOAuthLink,
} from '@/server/oauth-link-containment'
import { redactOAuthLinkRef } from '@/server/oauth-link-intent'
import { oauthLinkIntentService } from '@/server/oauth-link-intent-drizzle'
import { observeOAuthLinkCanary } from '@/server/oauth-link-observability'
import { createAuthenticatedOAuthLinkSessionResolver } from '@/server/oauth-link-session'
import {
	getCurrentOrganizationId,
	resolveSessionOrganizationId,
} from '@/server/organization-context'
import {
	getDiscordProviderConfig,
	getGithubProviderConfig,
} from '@/server/oauth-provider-config'
import { measureIfSlow } from '@/server/perf'
import DiscordProvider from '@auth/core/providers/discord'
import GithubProvider from '@auth/core/providers/github'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import NextAuth, { type DefaultSession, type NextAuthConfig } from 'next-auth'

import { userSchema } from '@coursebuilder/core/schemas'

type Role = 'admin' | 'user' | string

/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */
declare module 'next-auth' {
	interface Session extends DefaultSession {
		user: {
			id: string
			role: Role
		} & DefaultSession['user']
	}

	interface User {
		// ...other properties
		id?: string
		email?: string | null
		role?: Role
		roles: {
			id: string
			name: string
			description: string | null
			active: boolean
			createdAt: Date | null
			updatedAt: Date | null
			deletedAt: Date | null
		}[]
		entitlements: {
			type: string
			expires?: Date | null
			metadata: Record<string, any> | null
		}[]
		memberships?:
			| {
					organizationId: string | null
					id: string
					name: string
					description: string | null
					active: boolean
					createdAt: Date | null
					updatedAt: Date | null
					deletedAt: Date | null
			  }[]
			| null
		organizationRoles?: {
			organizationId: string | null
			id: string
			name: string
			description: string | null
			active: boolean
			createdAt: Date | null
			updatedAt: Date | null
			deletedAt: Date | null
		}[]
	}
}

const oauthContainmentAdapter =
	createOAuthContainmentAdapter(courseBuilderAdapter)

const getSessionAndUser =
	courseBuilderAdapter.getSessionAndUser?.bind(courseBuilderAdapter)
if (!getSessionAndUser) {
	throw new Error('OAuth containment requires database sessions')
}
const getAuthenticatedOAuthLinkSession =
	createAuthenticatedOAuthLinkSessionResolver({
		getCookieStore: cookies,
		getSessionAndUser,
	})

const oauthContainmentSignInCallback = createOAuthContainmentSignInCallback({
	getCookieStore: cookies,
	findAccountOwner: async (account) =>
		(await courseBuilderAdapter.getUserByAccount?.(account)) ?? null,
	getAuthenticatedSession: getAuthenticatedOAuthLinkSession,
	consumeLinkIntent: (input) => oauthLinkIntentService.consume(input),
	observe: observeOAuthLinkCanary,
})

async function triggerVerifiedOAuthRoleSync({
	account,
	targetUserId,
	flowId,
}: NonNullable<ReturnType<typeof takeVerifiedOAuthLink>>) {
	const common = {
		flowId,
		provider: account.provider,
		intentRef: undefined,
		targetUserRef: redactOAuthLinkRef(targetUserId),
		accountRef: redactOAuthLinkRef(account.providerAccountId),
	}
	await observeOAuthLinkCanary({
		...common,
		action: 'role_sync_trigger',
		result: 'allowed',
	})
	try {
		await inngest.send({
			name: OAUTH_PROVIDER_ACCOUNT_LINKED_EVENT,
			data: {
				account: toOAuthProviderAccountReference(account),
				flowId,
			},
			user: { id: targetUserId },
		})
		await observeOAuthLinkCanary({
			...common,
			action: 'flow_completed',
			result: 'linked',
		})
	} catch (error) {
		await log.error('auth.oauth.link-event.failed', {
			flowId,
			provider: account.provider,
			targetUserRef: common.targetUserRef,
			accountRef: common.accountRef,
			error: error instanceof Error ? error.message : String(error),
		})
		await observeOAuthLinkCanary({
			...common,
			action: 'flow_completed',
			result: 'denied',
		})
	}
}

const postSignInInvitationHandler = createPostSignInInvitationHandler({
	acceptInvitations: acceptBillingAdminInvitations,
	logAccepted: ({ userId, organizationCount }) => {
		void log.info('auth.billing-admin-invitations.accepted', {
			userId,
			organizationCount,
		})
	},
	logFailed: ({ userId, error }) => {
		void log.error('auth.billing-admin-invitations.failed', {
			userId,
			error,
		})
	},
})

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authOptions: NextAuthConfig = {
	logger: authLogger,
	events: {
		createUser: async ({ user }) => {
			await inngest.send({ name: USER_CREATED_EVENT, user, data: {} })
		},
		linkAccount: async ({ user, account }) => {
			await inngest.send({
				name: OAUTH_PROVIDER_ACCOUNT_LINKED_EVENT,
				data: {
					account: toOAuthProviderAccountReference(account),
				},
				user: { id: user.id },
			})
		},
		signIn: async (input) => {
			const verifiedLink = input.user.id
				? takeVerifiedOAuthLink(input.user.id)
				: null
			if (verifiedLink) await triggerVerifiedOAuthRoleSync(verifiedLink)
			await postSignInInvitationHandler(input)
		},
		signOut: async () => {
			const cookieStore = await cookies()
			cookieStore.delete('organizationId')
			clearLegacyOAuthLinkCookies(cookieStore)
		},
	},
	callbacks: {
		signIn: oauthContainmentSignInCallback,
		session: async ({ session, user }) => {
			const dbUser = await db.query.users.findFirst({
				where: (users, { eq }) => eq(users.id, user.id),
				with: {
					accounts: true,
					organizationMemberships: {
						with: {
							organization: true,
							organizationMembershipRoles: {
								with: {
									role: true,
								},
							},
						},
					},
				},
			})

			const discordAccount = dbUser?.accounts.find(
				(account) => account.provider === 'discord',
			)

			const nowMs = Date.now()
			const discordTokenExpired = isDiscordTokenExpired(
				discordAccount?.expires_at ?? null,
				nowMs,
			)

			if (discordAccount && discordTokenExpired) {
				const claimExpiresAt = getDiscordRefreshClaimExpiresAt(nowMs)
				const expectedCredentials: DiscordAccountCredentials = {
					accessToken: discordAccount.access_token,
					refreshToken: discordAccount.refresh_token,
					expiresAt: discordAccount.expires_at,
				}
				const accountIdentityCondition = and(
					eq(
						accounts.providerAccountId,
						discordAccount.providerAccountId,
					),
					eq(accounts.provider, 'discord'),
					eq(accounts.userId, user.id),
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
					...(update.expiresAt !== undefined
						? { expires_at: update.expiresAt }
						: {}),
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
				} else {
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
								refreshedToken.status === 'failed'
									? refreshedToken.lastStatus
									: null,
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
			}

			const userRoles = await db.query.userRoles.findMany({
				where: (ur, { eq }) => eq(ur.userId, user.id),
				with: {
					role: true,
				},
			})

			const requestedOrganizationId = await getCurrentOrganizationId()
			const role = dbUser?.role || 'user'

			const organizationRoles =
				dbUser?.organizationMemberships.flatMap((membership) =>
					membership.organizationMembershipRoles.flatMap((membershipRole) =>
						membershipRole.active &&
						!membershipRole.deletedAt &&
						membershipRole.role.active &&
						!membershipRole.role.deletedAt
							? [membershipRole.role]
							: [],
					),
				) || []
			const organizationId = resolveSessionOrganizationId(
				requestedOrganizationId,
				organizationRoles,
			)

			const currentMembership = organizationId
				? await db.query.organizationMemberships.findFirst({
						where: and(
							eq(organizationMemberships.organizationId, organizationId),
							eq(organizationMemberships.userId, user.id),
						),
						orderBy: (om, { asc }) => [asc(om.createdAt)],
					})
				: null

			const activeEntitlements = currentMembership
				? await db.query.entitlements.findMany({
						where: and(
							eq(entitlements.organizationMembershipId, currentMembership.id),
							or(
								isNull(entitlements.expiresAt),
								gt(entitlements.expiresAt, sql`CURRENT_TIMESTAMP`),
							),
							isNull(entitlements.deletedAt),
						),
					})
				: []

			return {
				...session,
				user: {
					...session.user,
					id: user.id,
					role: role as Role,
					roles: userRoles.map((userRole) => userRole.role),
					organizationRoles,
					entitlements: activeEntitlements.map((e) => ({
						type: e.entitlementType,
						expires: e.expiresAt,
						metadata: e.metadata || null,
					})),
				},
			}
		},
	},
	adapter: oauthContainmentAdapter,
	providers: [
		/**
		 * ...add more providers here.
		 *
		 * Most other providers require a bit more work than the Discord provider. For example, the
		 * GitHub provider requires you to add the `refresh_token_expires_in` field to the Account
		 * model. Refer to the NextAuth.js docs for the provider you want to use. Example:
		 *
		 * @see https://next-auth.js.org/providers/github
		 */
		...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
			? [
					GithubProvider(
						getGithubProviderConfig({
							clientId: env.GITHUB_CLIENT_ID,
							clientSecret: env.GITHUB_CLIENT_SECRET,
						}),
					),
				]
			: []),
		...(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET
			? [
					DiscordProvider(
						getDiscordProviderConfig({
							clientId: env.DISCORD_CLIENT_ID,
							clientSecret: env.DISCORD_CLIENT_SECRET,
						}),
					),
				]
			: []),
		emailProvider,
	],
	pages: {
		signIn: '/login',
		error: '/error',
		verifyRequest: '/check-your-email',
	},
}

const nextAuth = NextAuth(authOptions)

export const { auth, signIn, signOut } = nextAuth
export const GET = (request: Parameters<typeof nextAuth.handlers.GET>[0]) =>
	runWithOAuthContainmentRequest(
		request,
		() => nextAuth.handlers.GET(request),
		observeOAuthLinkCanary,
	)
export const POST = (request: Parameters<typeof nextAuth.handlers.POST>[0]) =>
	runWithOAuthContainmentRequest(
		request,
		() => nextAuth.handlers.POST(request),
		observeOAuthLinkCanary,
	)

export const getServerAuthSession = cache(async () => {
	return measureIfSlow({
		event: 'perf.auth.session.slow',
		thresholdMs: 250,
		operation: async () => {
			const session = await auth()
			const user = userSchema.optional().nullable().parse(session?.user)
			const parsedUser = UserSchema.nullish().parse(session?.user)
			const ability = getAbility({ user: parsedUser || undefined })

			return { session: session ? { ...session, user } : null, ability }
		},
	})
})

export type Provider = {
	id: string
	name: string
	type: string
	style: {
		logo: string
		bg: string
		text: string
	}
	signinUrl: string
}

export function getProviders(): Record<string, Provider> | null {
	const providerKeys: (keyof Provider)[] = ['id', 'name', 'type', 'style']
	return authOptions.providers.reduce((acc, provider) => {
		return {
			...acc,
			// @ts-ignore
			[provider.id]: {
				...getKeyValuesFromObject<Provider>(provider, providerKeys),
				// @ts-ignore
				signinUrl: `/api/auth/signin/${provider.id}`,
			},
		}
	}, {})
}

function getKeyValuesFromObject<T>(obj: any, keys: (keyof T)[]): T {
	return keys.reduce((acc, key) => {
		if (obj[key]) {
			acc[key] = obj[key]
		}
		return acc
	}, {} as T)
}
