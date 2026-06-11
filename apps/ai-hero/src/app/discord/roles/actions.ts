'use server'

import { db } from '@/db'
import { accounts, entitlements, entitlementTypes, users } from '@/db/schema'
import { env } from '@/env.mjs'
import { DiscordError, DiscordMember } from '@/lib/discord'
import { fetchAsDiscordBot, fetchJsonAsDiscordBot } from '@/lib/discord-query'
import { getServerAuthSession } from '@/server/auth'
import { and, eq, inArray, isNull } from 'drizzle-orm'

export type DiscordRole = {
	id: string
	name: string
	color: number
	position: number
}

export type RoleStatus = {
	roleId: string
	roleName: string
	roleColor: string
	source: string
	sourceType: string
	assigned: boolean
}

/**
 * Get the user's Discord connection, entitlements, and role sync state.
 */
export async function getDiscordRoleState() {
	const { session } = await getServerAuthSession()
	if (!session?.user) return null

	const user = await db.query.users.findFirst({
		where: eq(users.id, session.user.id),
		with: {
			accounts: true,
		},
	})

	if (!user) return null

	const discordAccount = user.accounts.find(
		(a: { provider: string }) => a.provider === 'discord',
	)

	if (!discordAccount) return { connected: false as const, userId: user.id }

	// Get the user's discord member data (current roles)
	let currentRoles: string[] = []
	let discordUsername: string | null = null
	try {
		const member = await fetchJsonAsDiscordBot<DiscordMember | DiscordError>(
			`guilds/${env.DISCORD_GUILD_ID}/members/${discordAccount.providerAccountId}`,
		)
		if ('user' in member) {
			currentRoles = member.roles
			discordUsername = member.user?.username ?? null
		}
	} catch {
		// Member might not be in the guild
	}

	// Get all guild roles for name/color lookup
	let guildRoles: DiscordRole[] = []
	try {
		const rolesResponse = await fetchJsonAsDiscordBot<
			DiscordRole[] | DiscordError
		>(`guilds/${env.DISCORD_GUILD_ID}/roles`)
		if (Array.isArray(rolesResponse)) {
			guildRoles = rolesResponse
		}
	} catch {
		// Fallback to empty
	}

	const roleMap = new Map(guildRoles.map((r) => [r.id, r]))

	// Get discord-related entitlement type IDs
	const discordEntitlementTypes = await db.query.entitlementTypes.findMany({
		where: eq(entitlementTypes.name, 'cohort_discord_role'),
	})
	const workshopEntitlementTypes = await db.query.entitlementTypes.findMany({
		where: eq(entitlementTypes.name, 'workshop_discord_role'),
	})
	const allDiscordTypeIds = [
		...discordEntitlementTypes,
		...workshopEntitlementTypes,
	].map((t) => t.id)

	// Get user's discord role entitlements (filtered in DB, not in memory)
	const discordEntitlements =
		allDiscordTypeIds.length > 0
			? await db.query.entitlements.findMany({
					where: and(
						eq(entitlements.userId, user.id),
						inArray(entitlements.entitlementType, allDiscordTypeIds),
						isNull(entitlements.deletedAt),
					),
				})
			: []

	// Build role status list
	const roles: RoleStatus[] = discordEntitlements
		.filter(
			(e) => (e.metadata as Record<string, unknown> | null)?.discordRoleId,
		)
		.map((e) => {
			const roleId = (e.metadata as Record<string, unknown>)
				.discordRoleId as string
			const guildRole = roleMap.get(roleId)
			const assigned = currentRoles.includes(roleId)
			return {
				roleId,
				roleName: guildRole?.name ?? `Role ${roleId}`,
				roleColor: guildRole?.color
					? `#${guildRole.color.toString(16).padStart(6, '0')}`
					: '#5865F2',
				source: e.sourceType === 'purchase' ? 'Purchase' : e.sourceType,
				sourceType: e.entitlementType,
				assigned,
			}
		})

	return {
		connected: true as const,
		userId: user.id,
		discordId: discordAccount.providerAccountId,
		discordUsername,
		currentRoleCount: currentRoles.length,
		roles,
		allAssigned: roles.every((r) => r.assigned),
		needsSync: roles.some((r) => !r.assigned),
	}
}

/**
 * Sync all eligible Discord roles for the current user.
 * Reads entitlements and PATCHes the Discord member's roles.
 */
export async function syncDiscordRoles(): Promise<{
	success: boolean
	synced: number
	error?: string
}> {
	const { session } = await getServerAuthSession()
	if (!session?.user)
		return { success: false, synced: 0, error: 'Not logged in' }

	const discordAccount = await db.query.accounts.findFirst({
		where: and(
			eq(accounts.userId, session.user.id),
			eq(accounts.provider, 'discord'),
		),
	})

	if (!discordAccount) {
		return { success: false, synced: 0, error: 'Discord not connected' }
	}

	// Get current member roles
	const member = await fetchJsonAsDiscordBot<DiscordMember | DiscordError>(
		`guilds/${env.DISCORD_GUILD_ID}/members/${discordAccount.providerAccountId}`,
	)

	if (!('user' in member)) {
		return {
			success: false,
			synced: 0,
			error: 'Not a member of the Discord server. Join first, then sync.',
		}
	}

	// Get all discord entitlement type IDs
	const cohortType = await db.query.entitlementTypes.findFirst({
		where: eq(entitlementTypes.name, 'cohort_discord_role'),
	})
	const workshopType = await db.query.entitlementTypes.findFirst({
		where: eq(entitlementTypes.name, 'workshop_discord_role'),
	})

	const typeIds = [cohortType?.id, workshopType?.id].filter(Boolean) as string[]

	if (typeIds.length === 0) {
		return { success: true, synced: 0 }
	}

	// Filter in DB, not in memory
	const discordEntitlements = await db.query.entitlements.findMany({
		where: and(
			eq(entitlements.userId, session.user.id),
			inArray(entitlements.entitlementType, typeIds),
			isNull(entitlements.deletedAt),
		),
	})

	const discordRoleIds = discordEntitlements
		.map(
			(e) =>
				(e.metadata as Record<string, unknown> | null)?.discordRoleId as string,
		)
		.filter(Boolean)

	if (discordRoleIds.length === 0) {
		return { success: true, synced: 0 }
	}

	// Merge with existing roles (don't remove any)
	const mergedRoles = Array.from(new Set([...member.roles, ...discordRoleIds]))

	const newRolesCount = mergedRoles.length - member.roles.length

	if (newRolesCount === 0) {
		return { success: true, synced: 0 }
	}

	// PATCH the member and check the response
	const res = await fetchAsDiscordBot(
		`guilds/${env.DISCORD_GUILD_ID}/members/${discordAccount.providerAccountId}`,
		{
			method: 'PATCH',
			body: JSON.stringify({ roles: mergedRoles }),
			headers: { 'Content-Type': 'application/json' },
		},
	)

	if (!res.ok) {
		const errorBody = await res.text().catch(() => '')
		return {
			success: false,
			synced: 0,
			error: `Discord API error (${res.status}): ${errorBody.slice(0, 200)}`,
		}
	}

	return { success: true, synced: newRolesCount }
}
