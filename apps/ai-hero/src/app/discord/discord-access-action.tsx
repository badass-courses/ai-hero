import Link from 'next/link'

import { Button } from '@coursebuilder/ui'

import type { DiscordAccessState } from './discord-access'

type RequestLinkAction = () => Promise<void>

export function DiscordAccessAction({
	state,
	requestLink,
}: {
	state: DiscordAccessState
	requestLink?: RequestLinkAction
}) {
	if (state === 'linked') {
		return (
			<Button asChild className="rounded-[9px]">
				<Link href="/discord/redirect">Continue to Discord</Link>
			</Button>
		)
	}

	if (state === 'sign-in') {
		return (
			<div className="flex flex-col items-center gap-3 text-center text-sm">
				<p>Sign in with email before you link Discord.</p>
				<Button asChild className="rounded-[9px]">
					<Link href="/login?callbackUrl=%2Fdiscord">Sign in with email</Link>
				</Button>
			</div>
		)
	}

	if (state === 'rollout-unavailable') {
		return (
			<div className="flex flex-col items-center gap-3 text-center text-sm">
				<p>Discord linking is rolling out gradually. Try again later.</p>
				<Button type="button" disabled className="rounded-[9px]">
					Link Discord account
				</Button>
			</div>
		)
	}

	const message =
		state === 'expired'
			? 'This link expired. Try again.'
			: state === 'denied'
				? "We couldn't link that Discord account. Try again."
				: 'Link Discord to continue.'

	return (
		<div className="flex flex-col items-center gap-3 text-center text-sm">
			<p>{message}</p>
			<form action={requestLink}>
				<Button type="submit" disabled={!requestLink} className="rounded-[9px]">
					{state === 'ready' ? 'Link Discord account' : 'Try again'}
				</Button>
			</form>
		</div>
	)
}
