import * as React from 'react'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { ContributorImage } from '@/components/contributor'
import LayoutClient from '@/components/layout-client'
import { getDiscordAccount } from '@/lib/discord-query'
import { requestOAuthAccountLink } from '@/lib/oauth-link-actions'
import { getServerAuthSession } from '@/server/auth'
import { isDiscordRelinkEnabledForUser } from '@/server/oauth-link-rollout'

import { DiscordAccessAction } from './discord-access-action'
import { getDiscordAccessState } from './discord-access'

export const metadata: Metadata = {
	title: 'Join AI Hero Discord',
	description: 'Join AI Hero Discord',
	openGraph: {
		images: [
			{
				url: 'https://res.cloudinary.com/total-typescript/image/upload/v1738075018/aihero.dev/aihero-discord-og_2x_uneisf.jpg',
			},
		],
	},
}

export default async function Discord({
	searchParams,
}: {
	searchParams: Promise<{ error?: string; link?: string }>
}) {
	await headers()
	const { error, link } = await searchParams
	const discordAccessState = await getDiscordAccessState({
		getSession: getServerAuthSession,
		findDiscordAccount: getDiscordAccount,
		linkResult: link,
		canLinkUser: isDiscordRelinkEnabledForUser,
	})

	return (
		<LayoutClient withContainer>
			<main className="flex min-h-[calc(100vh-var(--nav-height))] flex-col items-center justify-center gap-10 bg-[#7289DA] px-5 text-black dark:text-black">
				<h1 className="mx-auto w-full max-w-xl text-balance text-center text-2xl sm:text-3xl">
					Join <ContributorImage className="inline-block" />{' '}
					{process.env.NEXT_PUBLIC_PARTNER_FIRST_NAME}{' '}
					{process.env.NEXT_PUBLIC_PARTNER_LAST_NAME}'s AI Hero Discord
				</h1>

				{error && (
					<div className="mx-auto max-w-md rounded-lg bg-red-100 px-4 py-3 text-center text-sm text-red-800">
						{decodeURIComponent(error)}
					</div>
				)}

				<DiscordAccessAction
					state={discordAccessState}
					requestLink={requestOAuthAccountLink}
				/>
			</main>
		</LayoutClient>
	)
}
