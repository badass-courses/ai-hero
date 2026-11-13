import { db } from '@/db'
import { accounts, users } from '@/db/schema'
import { env } from '@/env.mjs'
import { inngest } from '@/inngest/inngest.server'
import { discordRoleClient, type DiscordRoleClient } from '@/lib/discord-utils'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

// Re-export existing event constants and schemas for backwards compatibility
export const USER_ADDED_TO_COHORT_EVENT = 'cohort/user-added'
export const USER_ADDED_TO_WORKSHOP_EVENT = 'workshop/user-added'

export const UserAddedToCohortEventSchema = z.object({
	cohortId: z.string(),
	userId: z.string(),
	discordRoleId: z.string().optional(),
})

export const UserAddedToWorkshopEventSchema = z.object({
	workshopId: z.string(),
	userId: z.string(),
	discordRoleId: z.string().optional(),
})

export type UserAddedToCohortEvent = z.infer<
	typeof UserAddedToCohortEventSchema
>
export type UserAddedToWorkshopEvent = z.infer<
	typeof UserAddedToWorkshopEventSchema
>

// Union type for event handling
type DiscordRoleEvent =
	| { name: 'cohort/user-added'; data: UserAddedToCohortEvent }
	| { name: 'workshop/user-added'; data: UserAddedToWorkshopEvent }

// Configuration for event-specific behavior
const DISCORD_EVENT_CONFIG = {
	'cohort/user-added': {
		logPrefix: 'cohort',
	},
	'workshop/user-added': {
		logPrefix: 'workshop',
	},
} as const

/**
 * Extract event details from either cohort or workshop events
 */
const getEventDetails = (event: DiscordRoleEvent) => {
	return {
		userId: event.data.userId,
		discordRoleId: event.data.discordRoleId,
		eventType: event.name.split('/')[0] as 'cohort' | 'workshop',
		resourceId:
			event.name === 'cohort/user-added'
				? (event.data as UserAddedToCohortEvent).cohortId
				: (event.data as UserAddedToWorkshopEvent).workshopId,
	}
}

/**
 * Resolve Discord role IDs to assign
 */
const resolveDiscordRoleId = (providedRoleId: string | undefined): string[] => {
	// Both cohort and workshop events work identically - simple role append
	return providedRoleId ? [providedRoleId] : []
}

/**
 * Add roles to a guild member one at a time.
 *
 * A purchase fires the cohort and workshop events together. Each used to read
 * the member's roles and PATCH back the whole list, so concurrent runs could
 * overwrite each other's role. The single-role PUT is atomic on Discord's side.
 * Failures throw so the step retries; a member not in the guild is skipped
 * (they get their roles when they link or sync).
 */
export async function addDiscordRoles(
	client: Pick<DiscordRoleClient, 'lookupMember' | 'addRole'>,
	userId: string,
	newRoleIds: string[],
) {
	if (newRoleIds.length === 0) return 'No roles to assign'
	const member = await client.lookupMember(userId)
	if (member.kind !== 'member') return { skipped: member.kind }
	const missing = newRoleIds.filter((roleId) => !member.roles.includes(roleId))
	for (const roleId of missing)
		await client.addRole(member.discordAccountId, roleId)
	return { added: missing, alreadyHad: newRoleIds.length - missing.length }
}

/**
 * Unified Discord Role Assignment Workflow
 * Handles both cohort and workshop Discord role assignments
 */
export const addDiscordRoleWorkflow = inngest.createFunction(
	{
		id: `add-discord-role-workflow`,
		name: `Add Discord Role Workflow`,
	},
	[
		{ event: USER_ADDED_TO_COHORT_EVENT },
		{ event: USER_ADDED_TO_WORKSHOP_EVENT },
	],
	async ({ event, step }) => {
		// Extract event details
		const eventDetails = getEventDetails(event as DiscordRoleEvent)
		const { userId, discordRoleId, eventType } = eventDetails
		const config =
			DISCORD_EVENT_CONFIG[
				`${eventType}/user-added` as keyof typeof DISCORD_EVENT_CONFIG
			]

		// Early exit if no Discord role ID provided
		if (!discordRoleId) {
			return 'No discord role id found'
		}

		// Get user with accounts
		const user = await step.run('get user', async () => {
			return db.query.users.findFirst({
				where: eq(users.id, userId),
				with: {
					accounts: true,
				},
			})
		})

		if (!user) throw new Error('No user found')

		// Check for Discord account connection
		const discordAccount = await step.run(
			'check if discord is connected',
			async () => {
				return db.query.accounts.findFirst({
					where: and(
						eq(accounts.userId, user.id),
						eq(accounts.provider, 'discord'),
					),
				})
			},
		)

		if (discordAccount) {
			// Resolve role IDs to assign
			const roleIds = resolveDiscordRoleId(discordRoleId)

			return await step.run('add discord roles', () =>
				addDiscordRoles(discordRoleClient, user.id, roleIds),
			)
		}

		return 'No discord account found for user'
	},
)

// Export legacy function names for backwards compatibility
export const addCohortRoleDiscord = addDiscordRoleWorkflow
export const addWorkshopRoleDiscord = addDiscordRoleWorkflow

// Export legacy event types for backwards compatibility
export type UserAddedToCohort = {
	name: typeof USER_ADDED_TO_COHORT_EVENT
	data: UserAddedToCohortEvent
}

export type UserAddedToWorkshop = {
	name: typeof USER_ADDED_TO_WORKSHOP_EVENT
	data: UserAddedToWorkshopEvent
}
