export function resolveDiscordRoleSyncCredentials({
	eventUserId,
	eventProviderAccountId,
	currentAccount,
}: {
	eventUserId: string
	eventProviderAccountId: string
	currentAccount: {
		userId: string
		providerAccountId: string
		accessToken: string | null
	} | null
}) {
	if (
		!currentAccount ||
		currentAccount.userId !== eventUserId ||
		currentAccount.providerAccountId !== eventProviderAccountId ||
		!currentAccount.accessToken
	) {
		return null
	}
	return { accessToken: currentAccount.accessToken }
}
