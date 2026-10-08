export function getGithubProviderConfig({
	clientId,
	clientSecret,
}: {
	clientId: string
	clientSecret: string
}) {
	return {
		clientId,
		clientSecret,
		issuer: 'https://github.com/login/oauth',
		allowDangerousEmailAccountLinking: true,
	}
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
		// Discord may return an ID token even for OAuth. Auth.js validates its
		// issuer before our sign-in callback; its fallback is https://authjs.dev.
		issuer: 'https://discord.com',
		allowDangerousEmailAccountLinking: true,
		authorization:
			'https://discord.com/api/oauth2/authorize?scope=identify+email+guilds.join+guilds',
	}
}
