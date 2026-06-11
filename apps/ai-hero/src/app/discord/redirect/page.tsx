import { notFound, redirect } from 'next/navigation'
import { env } from '@/env.mjs'
import { getDiscordAccount } from '@/lib/discord-query'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

export default async function DiscordRedirect() {
	if (!env.NEXT_PUBLIC_DISCORD_INVITE_URL) {
		void log.error('discord.redirect.config-missing', {
			action: 'not-found',
			error: 'Discord invite URL is not set',
		})
		return notFound()
	}

	const { session } = await getServerAuthSession()

	if (!session?.user) {
		void log.warn('discord.redirect.unauthorized', {
			action: 'redirect.login',
		})
		redirect(
			'/login?callbackUrl=/discord&message=Please+log+in+first+to+connect+Discord',
		)
	}

	const discordAccount = await getDiscordAccount(session.user.id)

	if (!discordAccount) {
		void log.warn('discord.redirect.account-missing', {
			userId: session.user.id,
			action: 'redirect.error',
			error: 'Discord account was not linked after OAuth',
		})
		redirect('/discord?error=Discord+account+was+not+linked.+Please+try+again.')
	}

	void log.info('discord.redirect.success', {
		userId: session.user.id,
		action: 'redirect.invite',
	})

	redirect(env.NEXT_PUBLIC_DISCORD_INVITE_URL)
}
