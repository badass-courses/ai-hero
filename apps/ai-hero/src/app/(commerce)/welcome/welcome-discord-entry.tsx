import Link from 'next/link'
import { Icon } from '@/components/brand/icons'

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
		<aside className="mt-10 flex flex-col items-start gap-4 rounded-[11px] border border-border bg-card p-6 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex flex-col gap-1">
				<h2 className="font-heading text-lg font-bold">Join the Discord</h2>
				<p className="text-muted-foreground text-sm">
					Link your Discord account to get into the AI Hero server.
				</p>
			</div>
			<Button asChild className="rounded-[9px]">
				<Link href="/discord" className="flex items-center gap-2">
					<Icon name="Discord" size="20" />
					Join Discord
				</Link>
			</Button>
		</aside>
	)
}
