import type { db } from '@/db'
import { entitlements } from '@/db/schema'
import { isDiscordTokenExpired } from '@/server/discord-token-refresh-persistence'
import {
	isSessionAccessCacheable,
	type SessionAccess,
	type SessionAccessCache,
	type SessionAccessMembership,
	type SessionAccessRole,
} from '@/server/session-access-cache'
import { resolveSessionOrganizationId } from '@/server/organization-context'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'

type Database = Pick<typeof db, 'query'>

export type SessionEntitlementRow = {
	entitlementType: string
	expiresAt: Date | null
	metadata: Record<string, any> | null
}

/**
 * One statement for the user's global roles, membership ids, membership roles
 * and Discord token expiry. It reads no OAuth tokens and no organization rows;
 * the session never exposed either.
 */
export function createSessionAccessLoader(database: Database) {
	return async (userId: string): Promise<SessionAccess> => {
		const row = await database.query.users.findFirst({
			where: (users, { eq }) => eq(users.id, userId),
			columns: { id: true },
			with: {
				roles: { columns: { roleId: true }, with: { role: true } },
				accounts: {
					where: (accounts, { eq }) => eq(accounts.provider, 'discord'),
					columns: { expires_at: true },
				},
				organizationMemberships: {
					columns: { id: true, organizationId: true, createdAt: true },
					with: {
						organizationMembershipRoles: {
							columns: { active: true, deletedAt: true },
							with: { role: true },
						},
					},
				},
			},
		})

		const memberships = row?.organizationMemberships ?? []
		const discordAccount = row?.accounts[0]
		return {
			roles: (row?.roles ?? []).map((userRole) => userRole.role),
			organizationRoles: memberships.flatMap((membership) =>
				membership.organizationMembershipRoles.flatMap((membershipRole) =>
					membershipRole.active &&
					!membershipRole.deletedAt &&
					membershipRole.role.active &&
					!membershipRole.role.deletedAt
						? [membershipRole.role]
						: [],
				),
			),
			memberships: memberships.map(({ id, organizationId, createdAt }) => ({
				id,
				organizationId,
				createdAt,
			})),
			discord: discordAccount
				? { expiresAt: discordAccount.expires_at ?? null }
				: null,
		}
	}
}

export function createSessionEntitlementsLoader(database: Database) {
	return (organizationMembershipId: string): Promise<SessionEntitlementRow[]> =>
		database.query.entitlements.findMany({
			where: and(
				eq(entitlements.organizationMembershipId, organizationMembershipId),
				or(
					isNull(entitlements.expiresAt),
					gt(entitlements.expiresAt, sql`CURRENT_TIMESTAMP`),
				),
				isNull(entitlements.deletedAt),
			),
		})
}

/**
 * The user's earliest membership in the organization, matching the former
 * `ORDER BY createdAt ASC` lookup. MySQL sorts NULL first in ascending order.
 */
export function selectCurrentMembership(
	memberships: SessionAccessMembership[],
	organizationId: string | null,
) {
	if (!organizationId) return null
	const time = (membership: SessionAccessMembership) =>
		membership.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY
	return (
		memberships
			.filter((membership) => membership.organizationId === organizationId)
			.reduce<SessionAccessMembership | null>(
				(earliest, membership) =>
					!earliest || time(membership) < time(earliest)
						? membership
						: earliest,
				null,
			) ?? null
	)
}

export type SessionCallbackDependencies = {
	loadAccess: (userId: string) => Promise<SessionAccess>
	loadEntitlements: (
		organizationMembershipId: string,
	) => Promise<SessionEntitlementRow[]>
	getRequestedOrganizationId: () => Promise<string | null>
	cache: SessionAccessCache
	/** Must not throw. Decides itself whether to block the request. */
	onExpiredDiscordToken: (userId: string) => Promise<void>
	now?: () => number
}

type SessionCallbackInput<TSession> = {
	session: TSession
	user: { id: string; role?: string | null }
}

export function createSessionCallback({
	loadAccess,
	loadEntitlements,
	getRequestedOrganizationId,
	cache,
	onExpiredDiscordToken,
	now = Date.now,
}: SessionCallbackDependencies) {
	async function loadCachedAccess(
		sessionToken: string | undefined,
		userId: string,
	) {
		if (!sessionToken) return loadAccess(userId)
		const cached = await cache.read(sessionToken, userId)
		if (cached.status === 'hit') return cached.access
		const access = await loadAccess(userId)
		if (cached.status === 'miss' && isSessionAccessCacheable(access)) {
			await cache.write(sessionToken, userId, cached.generation, access)
		}
		return access
	}

	return async function session<
		TSession extends { user?: object; sessionToken?: unknown },
	>({ session, user }: SessionCallbackInput<TSession>) {
		const sessionToken =
			typeof session.sessionToken === 'string' ? session.sessionToken : undefined
		const access = await loadCachedAccess(sessionToken, user.id)

		if (access.discord && isDiscordTokenExpired(access.discord.expiresAt, now())) {
			await onExpiredDiscordToken(user.id)
		}

		const requestedOrganizationId = await getRequestedOrganizationId()
		const organizationId = resolveSessionOrganizationId(
			requestedOrganizationId,
			access.organizationRoles,
		)
		const currentMembership = selectCurrentMembership(
			access.memberships,
			organizationId,
		)
		const activeEntitlements = currentMembership
			? await loadEntitlements(currentMembership.id)
			: []

		return {
			...session,
			user: {
				...session.user,
				id: user.id,
				role: user.role || 'user',
				roles: access.roles,
				organizationRoles: access.organizationRoles,
				entitlements: activeEntitlements.map((e) => ({
					type: e.entitlementType,
					expires: e.expiresAt,
					metadata: e.metadata || null,
				})),
			},
		}
	}
}

export type { SessionAccess, SessionAccessRole }
