export function getGithubProviderConfig({
	clientId,
	clientSecret,
}: {
	clientId: string
	clientSecret: string
}) {
	return { clientId, clientSecret }
}

export function getDiscordProviderConfig({
	clientId,
	clientSecret,
}: {
	clientId: string
	clientSecret: string
}) {
	return {
		clientId,
		clientSecret,
		authorization:
			'https://discord.com/api/oauth2/authorize?scope=identify+email+guilds.join+guilds',
	}
}
