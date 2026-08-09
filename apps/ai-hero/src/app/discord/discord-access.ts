export type DiscordAccessState =
	| 'linked'
	| 'ready'
	| 'expired'
	| 'denied'
	| 'sign-in'
	| 'rollout-unavailable'

type SessionResult = {
	session?: {
		user?: { id?: string | null } | null
	} | null
}

export async function getDiscordAccessState({
	getSession,
	findDiscordAccount,
	linkResult,
	canLinkUser = () => true,
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
	canLinkUser?: (userId: string) => boolean
}): Promise<DiscordAccessState> {
	const { session } = await getSession()
	const userId = session?.user?.id
	if (!userId) return 'sign-in'

	const account = await findDiscordAccount(userId)
	if (account?.access_token) return 'linked'
	if (linkResult === 'expired') return 'expired'
	if (linkResult === 'denied') return 'denied'
	if (!canLinkUser(userId)) return 'rollout-unavailable'
	return 'ready'
}
