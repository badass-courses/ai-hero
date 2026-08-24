import { resolveDiscordRoleSyncCredentials } from './discord-account-linked-owner'

export async function runDiscordProviderBoundary<T>({
	eventUserId,
	eventProviderAccountId,
	findCurrentAccount,
	callProvider,
	onDenied,
}: {
	eventUserId: string
	eventProviderAccountId: string
	findCurrentAccount: () => Promise<{
		userId: string
		providerAccountId: string
		accessToken: string | null
	} | null>
	callProvider: (accessToken: string) => Promise<T>
	onDenied: () => void | Promise<void>
}): Promise<{ status: 'allowed'; value: T } | { status: 'denied' }> {
	const credentials = resolveDiscordRoleSyncCredentials({
		eventUserId,
		eventProviderAccountId,
		currentAccount: await findCurrentAccount(),
	})
	if (!credentials) {
		await onDenied()
		return { status: 'denied' }
	}

	// The verified database credential stays inside this boundary. It is never
	// returned as step output or accepted from the queued event.
	return {
		status: 'allowed',
		value: await callProvider(credentials.accessToken),
	}
}
