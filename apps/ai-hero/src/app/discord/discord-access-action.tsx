import Link from 'next/link'

import { Button } from '@coursebuilder/ui'

import type { DiscordAccessState } from './discord-access'

type RequestLinkAction = () => Promise<void>
type SwitchLoginAction = () => Promise<void>

export function DiscordAccessAction({
	state,
	requestLink,
	switchLogin,
	supportEmail,
}: {
	state: DiscordAccessState
	requestLink?: RequestLinkAction
	switchLogin: SwitchLoginAction
	supportEmail: string
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

	if (state === 'account-conflict') {
		return (
			<div className="flex max-w-md flex-col items-center gap-4 text-center text-sm">
				<div className="flex flex-col gap-2">
					<p className="font-medium">
						This Discord account is already connected to another AI Hero login.
					</p>
					<p>
						Sign out, then sign in to AI Hero with the email you used when you
						first connected Discord. If you cannot access that login, contact
						support so we can verify both accounts.
					</p>
				</div>
				<div className="flex flex-wrap justify-center gap-3">
					<form action={switchLogin}>
						<Button type="submit" className="rounded-[9px]">
							Switch AI Hero login
						</Button>
					</form>
					<Button asChild variant="outline" className="rounded-[9px]">
						<Link href={`mailto:${supportEmail}`}>Contact support</Link>
					</Button>
				</div>
			</div>
		)
	}

	const message =
		state === 'expired'
			? 'This link expired. Try again.'
			: state === 'denied'
				? "We couldn't link that Discord account. Try again."
				: state === 'reconnect-required'
					? 'Discord needs to be reconnected. Link it again to restore access.'
					: 'Link Discord to continue.'

	return (
		<div className="flex flex-col items-center gap-3 text-center text-sm">
			<p>{message}</p>
			<form action={requestLink}>
				<Button type="submit" disabled={!requestLink} className="rounded-[9px]">
					{state === 'ready'
						? 'Link Discord account'
						: state === 'reconnect-required'
							? 'Reconnect Discord'
							: 'Try again'}
				</Button>
			</form>
		</div>
	)
}
