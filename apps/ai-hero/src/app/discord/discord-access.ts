export type DiscordAccessState = 'linked' | 'unavailable'

type SessionResult = {
	session?: {
		user?: { id?: string | null } | null
	} | null
}

export async function getDiscordAccessState({
	getSession,
	findDiscordAccount,
}: {
	getSession: () => SessionResult | Promise<SessionResult>
	findDiscordAccount: (userId: string) => unknown | Promise<unknown>
}): Promise<DiscordAccessState> {
	const { session } = await getSession()
	const userId = session?.user?.id
	if (!userId) return 'unavailable'

	const account = await findDiscordAccount(userId)
	return account ? 'linked' : 'unavailable'
}
