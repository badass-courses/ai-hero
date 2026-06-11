export const GRANT_LEGEND_DISCORD_ROLE_EVENT =
	'cohort/grant-legend-discord-role'

export type GrantLegendDiscordRole = {
	name: typeof GRANT_LEGEND_DISCORD_ROLE_EVENT
	data: {
		purchaseId: string
		userId: string
	}
}
