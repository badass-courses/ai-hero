'use client'

import Link from 'next/link'
import { Icon } from '@/components/brand/icons'
import { disconnectDiscord } from '@/lib/discord-disconnect-action'
import { disconnectGithub } from '@/lib/github-query'
import { requestGithubOAuthAccountLink } from '@/lib/oauth-link-actions'

import { Button } from '@coursebuilder/ui'

import type { GithubProfileLinkStatus } from '../profile-link-status'

const githubLinkMessages: Record<GithubProfileLinkStatus, string> = {
	linked: 'GitHub account connected.',
	expired: 'The GitHub link expired. Try again.',
	denied: "We couldn't connect that GitHub account. Try again.",
	'account-conflict':
		'That GitHub account is already connected to another AI Hero login.',
	'not-enabled': 'GitHub linking is not enabled for this account yet.',
}

export function ProfileAccountConnections({
	githubAvailable,
	githubConnected,
	githubLinkingEnabled,
	githubLinkStatus,
	discordAvailable,
	discordConnected,
}: {
	githubAvailable: boolean
	githubConnected: boolean
	githubLinkingEnabled: boolean
	githubLinkStatus: GithubProfileLinkStatus | null
	discordAvailable: boolean
	discordConnected: boolean
}) {
	if (!githubAvailable && !discordAvailable) return null

	return (
		<fieldset className="mt-5 w-full">
			<h3 className="text-lg font-bold">Accounts</h3>
			{githubLinkStatus ? (
				<p className="text-muted-foreground mt-2 text-sm" role="status">
					{githubLinkMessages[githubLinkStatus]}
				</p>
			) : null}
			<ul className="divide-y border-b">
				{githubAvailable ? (
					<li className="flex items-center justify-between gap-4 py-3">
						<h4 className="inline-flex items-center gap-2 font-medium">
							<Icon name="Github" className="h-5 w-5" />
							GitHub
						</h4>
						{githubConnected ? (
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={async () => {
									await disconnectGithub()
									window.location.reload()
								}}
							>
								Disconnect
							</Button>
						) : githubLinkingEnabled ? (
							<Button
								type="button"
								size="sm"
								onClick={async () => {
									await requestGithubOAuthAccountLink()
								}}
							>
								Connect
							</Button>
						) : (
							<Button
								type="button"
								size="sm"
								disabled
								title="GitHub linking is not enabled for this account yet"
							>
								Not enabled
							</Button>
						)}
					</li>
				) : null}
				{discordAvailable ? (
					<li className="flex items-center justify-between gap-4 py-3">
						<h4 className="inline-flex items-center gap-2 font-medium">
							<Icon name="Discord" className="h-5 w-5" />
							Discord
						</h4>
						{discordConnected ? (
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={async () => {
									await disconnectDiscord()
									window.location.reload()
								}}
							>
								Disconnect
							</Button>
						) : (
							<Button asChild size="sm">
								<Link href="/discord">Connect</Link>
							</Button>
						)}
					</li>
				) : null}
			</ul>
		</fieldset>
	)
}
