export type DiscordAccessState =
	| 'linked'
	| 'reconnect-required'
	| 'ready'
	| 'expired'
	| 'denied'
	| 'account-conflict'
	| 'sign-in'

type SessionResult = {
	session?: {
		user?: { id?: string | null } | null
	} | null
}

export async function getDiscordAccessState({
	getSession,
	findDiscordAccount,
	linkResult,
}: {
	getSession: () => SessionResult | Promise<SessionResult>
	findDiscordAccount: (
		userId: string,
	) =>
		| { access_token?: string | null }
		| null
		| undefined
		| PromiseLike<{ access_token?: string | null } | null | undefined>
	linkResult?: string
}): Promise<DiscordAccessState> {
	const { session } = await getSession()
	const userId = session?.user?.id
	if (!userId) return 'sign-in'

	const account = await findDiscordAccount(userId)
	if (account?.access_token) return 'linked'
	if (linkResult === 'expired') return 'expired'
	if (linkResult === 'denied') return 'denied'
	if (linkResult === 'account-conflict') return 'account-conflict'
	if (account) return 'reconnect-required'
	return 'ready'
}
