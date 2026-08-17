import Link from 'next/link'

import { Button } from '@coursebuilder/ui'

type OAuthProvider = {
	id: string
	name: string
}

export function withoutDiscordProvider<T extends OAuthProvider>(
	providers: readonly T[],
): T[] {
	return providers.filter((provider) => provider.id !== 'discord')
}

export function PostPurchaseDiscordAccess({
	isDiscordConnected,
}: {
	isDiscordConnected: boolean
}) {
	if (isDiscordConnected) return null

	return (
		<div className="mx-auto flex w-full max-w-(--breakpoint-md) justify-center pb-8 sm:justify-start">
			<Button asChild>
				<Link href="/discord">Join Discord</Link>
			</Button>
		</div>
	)
}
