import Link from 'next/link'

import { Button } from '@coursebuilder/ui'

import type { DiscordAccessState } from './discord-access'

export function DiscordAccessAction({
	state,
}: {
	state: DiscordAccessState
}) {
	if (state === 'linked') {
		return (
		<Button asChild className="rounded-[9px]">
			<Link href="/discord/redirect">Continue to Discord</Link>
		</Button>
		)
	}

	return (
		<p className="text-center text-sm">
			Discord account linking is temporarily unavailable. Sign in with email if
			you need account access.
		</p>
	)
}
