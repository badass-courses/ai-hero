import { env } from '@/env.mjs'
import { DiscordMember } from '@/lib/discord'
import { fetchAsDiscordBot, getDiscordAccount } from '@/lib/discord-query'

export type DiscordMemberLookup =
	| { kind: 'no-account' }
	| { kind: 'not-member'; discordAccountId: string }
	| { kind: 'member'; discordAccountId: string; roles: string[] }

/**
 * Reads the user's guild membership. Only a 404 means "not in the guild";
 * a rate limit, outage or malformed body throws so the caller can retry.
 */
async function lookupDiscordMember(
	userId: string,
): Promise<DiscordMemberLookup> {
	const discordAccount = await getDiscordAccount(userId)
	if (!discordAccount) return { kind: 'no-account' }
	const discordAccountId = discordAccount.providerAccountId
	const res = await fetchAsDiscordBot(
		`guilds/${env.DISCORD_GUILD_ID}/members/${discordAccountId}`,
	)
	if (res.status === 404) return { kind: 'not-member', discordAccountId }
	if (!res.ok) throw new Error(`discord member lookup failed: ${res.status}`)
	const member = (await res.json()) as Partial<DiscordMember>
	if (!Array.isArray(member?.roles))
		throw new Error('discord member lookup returned no roles')
	return { kind: 'member', discordAccountId, roles: member.roles }
}

async function setDiscordMemberRole(
	discordAccountId: string,
	roleId: string,
	method: 'PUT' | 'DELETE',
) {
	const res = await fetchAsDiscordBot(
		`guilds/${env.DISCORD_GUILD_ID}/members/${discordAccountId}/roles/${roleId}`,
		{ method },
	)
	// Deleting a role the member no longer has is already done.
	if (res.ok || (method === 'DELETE' && res.status === 404)) return
	throw new Error(
		`discord ${method === 'PUT' ? 'add' : 'remove'} role failed: ${res.status}`,
	)
}

/** Discord role calls that throw on any failure that is worth retrying. */
export const discordRoleClient = {
	lookupMember: lookupDiscordMember,
	addRole: (discordAccountId: string, roleId: string) =>
		setDiscordMemberRole(discordAccountId, roleId, 'PUT'),
	removeRole: (discordAccountId: string, roleId: string) =>
		setDiscordMemberRole(discordAccountId, roleId, 'DELETE'),
}
export type DiscordRoleClient = typeof discordRoleClient

/**
 * Removes a Discord role from a user
 * @param userId - The user ID to remove the role from
 * @param roleId - The Discord role ID to remove
 * @returns Object with status and details about the operation. HTTP failures,
 *   including rate limits, come back as `error`, never `success` or `skipped`.
 */
export async function removeDiscordRole(userId: string, roleId: string) {
	let discordAccountId: string | undefined
	try {
		const member = await lookupDiscordMember(userId)
		if (member.kind === 'no-account') {
			return {
				status: 'skipped',
				reason: 'No Discord account found for user',
				userId,
			}
		}
		discordAccountId = member.discordAccountId

		if (member.kind === 'not-member') {
			return {
				status: 'skipped',
				reason: 'Discord member not found in guild',
				discordAccountId,
				userId,
			}
		}

		if (!member.roles.includes(roleId)) {
			return {
				status: 'skipped',
				reason: 'User does not have role to remove',
				userId,
				discordAccountId,
				roleId,
			}
		}

		await setDiscordMemberRole(discordAccountId, roleId, 'DELETE')

		return {
			status: 'success',
			removedRoleId: roleId,
			discordAccountId,
			userId,
		}
	} catch (error) {
		return {
			status: 'error',
			reason: error instanceof Error ? error.message : String(error),
			userId,
			discordAccountId,
			roleId,
		}
	}
}
