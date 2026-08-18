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
import {
	getDiscordRefreshFailureKind,
	getNextAuthErrorLogLevel,
} from '@/server/auth-log-policy'
import { createPostSignInInvitationHandler } from '@/server/auth-post-sign-in'
import { log, serializeError } from '@/server/logger'
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

function getOAuthLogData({
	provider,
	userId = null,
	accountId = null,
	action,
}: {
	provider: string
	userId?: string | null
	accountId?: string | null
	action: string
}) {
	return {
		provider,
		userId,
		accountId,
		action,
	}
}

function getDiscordLogData({
	userId = null,
	accountId = null,
	action,
}: {
	userId?: string | null
	accountId?: string | null
	action: string
}) {
	return getOAuthLogData({
		provider: 'discord',
		userId,
		accountId,
		action,
	})
}

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

async function refreshDiscordToken(account: {
	refresh_token: string | null
	providerAccountId?: string | null
	userId?: string | null
}) {
	try {
		if (!account.refresh_token) throw new Error('No refresh token')

		const myHeaders = new Headers()
		myHeaders.append('Content-Type', 'application/x-www-form-urlencoded')

		const urlencoded = new URLSearchParams()
		if (
			env.DISCORD_CLIENT_ID === undefined ||
			env.DISCORD_CLIENT_SECRET === undefined
		) {
			throw new Error('Discord client ID and secret are not set')
		}
		urlencoded.append('client_id', env.DISCORD_CLIENT_ID)
		urlencoded.append('client_secret', env.DISCORD_CLIENT_SECRET)
		urlencoded.append('grant_type', 'refresh_token')
		urlencoded.append('refresh_token', account.refresh_token)

		const requestOptions = {
			method: 'POST',
			headers: myHeaders,
			body: urlencoded,
		}

		const response = await fetch(
			'https://discord.com/api/oauth2/token',
			requestOptions,
		)

		const responseBody = (await response.json().catch(() => null)) as {
			error?: unknown
			access_token?: unknown
			expires_in?: unknown
			refresh_token?: unknown
		} | null
		if (!response.ok) {
			const errorCode =
				typeof responseBody?.error === 'string' ? responseBody.error : null
			const failureKind = getDiscordRefreshFailureKind(
				response.status,
				errorCode,
			)
			if (failureKind === 'user-must-relink') {
				return { error: failureKind }
			}
			throw new Error(`HTTP error! status: ${response.status}`)
		}
		if (
			typeof responseBody?.access_token !== 'string' ||
			typeof responseBody.expires_in !== 'number'
		) {
			throw new Error('Discord refresh response was invalid')
		}

		return {
			access_token: responseBody.access_token,
			expires_in: responseBody.expires_in,
			...(typeof responseBody.refresh_token === 'string' && {
				refresh_token: responseBody.refresh_token,
			}),
		}
	} catch (error) {
		void log.error('auth.discord.token-refresh', {
			...getDiscordLogData({
				userId: account.userId ?? null,
				accountId: account.providerAccountId ?? null,
				action: 'failed',
			}),
			error: error instanceof Error ? error.message : String(error),
		})
		return { error: 'refresh-failed' as const }
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
	logger: {
		error: (error) => {
			const serialized = serializeError(error)
			const data = {
				error: serialized,
				errorName: serialized.name ?? null,
				errorMessage: serialized.message,
				errorCode:
					typeof serialized.code === 'string' ||
					typeof serialized.code === 'number'
						? serialized.code
						: null,
				errorType: typeof serialized.type === 'string' ? serialized.type : null,
			}
			if (getNextAuthErrorLogLevel(serialized) === 'info') {
				void log.info('auth.nextauth.expected', data)
				return
			}
			void log.error('auth.nextauth.error', data)
		},
		warn: (code) => {
			void log.warn('auth.nextauth.warn', {
				code: String(code),
			})
		},
	},
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

			const isDiscordTokenExpired = Boolean(
				discordAccount?.expires_at &&
				discordAccount.expires_at * 1000 < Date.now(),
			)

			if (discordAccount && isDiscordTokenExpired) {
				void log.info('auth.discord.token-refresh', {
					...getDiscordLogData({
						userId: user.id,
						accountId: discordAccount.providerAccountId,
						action: 'start',
					}),
					expiredAt: discordAccount.expires_at ?? null,
				})
				const refreshedToken = await refreshDiscordToken({
					refresh_token: discordAccount.refresh_token,
					providerAccountId: discordAccount.providerAccountId,
					userId: user.id,
				})

				if (
					'access_token' in refreshedToken &&
					'expires_in' in refreshedToken &&
					'refresh_token' in refreshedToken
				) {
					await db
						.update(accounts)
						.set({
							access_token: refreshedToken.access_token,
							expires_at: Math.floor(
								Date.now() / 1000 + refreshedToken.expires_in,
							),
							refresh_token: refreshedToken.refresh_token,
						})
						.where(
							and(
								eq(
									accounts.providerAccountId,
									discordAccount.providerAccountId,
								),
								eq(accounts.provider, 'discord'),
								eq(accounts.userId, user.id),
							),
						)
				} else if (
					'error' in refreshedToken &&
					refreshedToken.error === 'user-must-relink'
				) {
					void log.info('auth.discord.token-refresh', {
						...getDiscordLogData({
							userId: user.id,
							accountId: discordAccount.providerAccountId,
							action: 'user-must-relink',
						}),
					})
					await db
						.update(accounts)
						.set({
							access_token: null,
							expires_at: null,
						})
						.where(
							and(
								eq(
									accounts.providerAccountId,
									discordAccount.providerAccountId,
								),
								eq(accounts.provider, 'discord'),
								eq(accounts.userId, user.id),
							),
						)
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
