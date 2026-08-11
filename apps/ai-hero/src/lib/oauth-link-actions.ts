'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { courseBuilderAdapter, db } from '@/db'
import { accounts } from '@/db/schema'
import {
	clearLegacyOAuthLinkCookies,
	writeOAuthLinkIntentCookie,
} from '@/lib/oauth-link-cookie'
import { oauthLinkIntentService } from '@/server/oauth-link-intent-drizzle'
import { createAuthenticatedOAuthLinkSessionResolver } from '@/server/oauth-link-session'
import { and, eq } from 'drizzle-orm'

import { createOAuthAccountLinkRequest } from './oauth-link-action'
import { signIn } from '@/server/auth'

const getSessionAndUser =
	courseBuilderAdapter.getSessionAndUser?.bind(courseBuilderAdapter)
if (!getSessionAndUser) {
	throw new Error('OAuth linking requires database sessions')
}

const getAuthenticatedSession = createAuthenticatedOAuthLinkSessionResolver({
	getCookieStore: cookies,
	getSessionAndUser,
})

const requestLink = createOAuthAccountLinkRequest({
	getAuthenticatedSession,
	findAccount: ({ userId, provider }) =>
		db.query.accounts.findFirst({
			where: and(eq(accounts.userId, userId), eq(accounts.provider, provider)),
		}),
	issueIntent: (input) => oauthLinkIntentService.issue(input),
	writeIntentCookie: async (input) => {
		const cookieStore = await cookies()
		clearLegacyOAuthLinkCookies(cookieStore)
		writeOAuthLinkIntentCookie(cookieStore, input)
	},
})

/**
 * Starts a Discord link from a fresh database session. The action accepts no
 * provider or user identity from the browser.
 */
export async function requestOAuthAccountLink() {
	const result = await requestLink()
	if (result.status === 'unauthenticated') {
		redirect('/login?callbackUrl=/discord')
	}
	if (result.status === 'linked') redirect('/discord/redirect')
	if (result.status === 'denied') redirect('/discord?link=denied')

	await signIn('discord', { redirectTo: '/discord/redirect' })
	redirect('/discord?link=denied')
}
