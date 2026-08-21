'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { courseBuilderAdapter, db } from '@/db'
import { accounts } from '@/db/schema'
import {
	clearLegacyOAuthLinkCookies,
	clearOAuthLinkIntentCookies,
	writeOAuthLinkIntentCookie,
} from '@/lib/oauth-link-cookie'
import { isGithubOAuthLinkEnabledForUser } from '@/server/github-oauth-link-rollout'
import { oauthLinkIntentService } from '@/server/oauth-link-intent-drizzle'
import { createAuthenticatedOAuthLinkSessionResolver } from '@/server/oauth-link-session'
import { and, eq } from 'drizzle-orm'

import {
	createOAuthAccountLinkRequest,
	createOAuthAccountSwitchLogin,
} from './oauth-link-action'
import {
	getRuntimeAuthCookiePolicy,
	signIn,
	signOut,
} from '@/server/auth'

const getSessionAndUser =
	courseBuilderAdapter.getSessionAndUser?.bind(courseBuilderAdapter)
if (!getSessionAndUser) {
	throw new Error('OAuth linking requires database sessions')
}

const getAuthenticatedSession = createAuthenticatedOAuthLinkSessionResolver({
	getCookieStore: cookies,
	getCookiePolicy: getRuntimeAuthCookiePolicy,
	getSessionAndUser,
})

const switchLogin = createOAuthAccountSwitchLogin({ signOut })

const findAccount = ({
	userId,
	provider,
}: {
	userId: string
	provider: 'discord' | 'github'
}) =>
	db.query.accounts.findFirst({
		where: and(eq(accounts.userId, userId), eq(accounts.provider, provider)),
	})

const clearIntentCookies = async () => {
	const cookieStore = await cookies()
	clearLegacyOAuthLinkCookies(cookieStore)
	clearOAuthLinkIntentCookies(cookieStore)
}

const writeIntentCookie = async (input: {
	rawToken: string
	expiresAt: Date
}) => {
	const [cookieStore, cookiePolicy] = await Promise.all([
		cookies(),
		getRuntimeAuthCookiePolicy(),
	])
	clearLegacyOAuthLinkCookies(cookieStore)
	clearOAuthLinkIntentCookies(cookieStore)
	writeOAuthLinkIntentCookie(cookieStore, input, cookiePolicy)
}

const requestDiscordLink = createOAuthAccountLinkRequest({
	provider: 'discord',
	getAuthenticatedSession,
	findAccount,
	issueIntent: (input) => oauthLinkIntentService.issue(input),
	clearIntentCookies,
	writeIntentCookie,
})

const requestGithubLink = createOAuthAccountLinkRequest({
	provider: 'github',
	getAuthenticatedSession,
	findAccount,
	issueIntent: (input) => oauthLinkIntentService.issue(input),
	clearIntentCookies,
	writeIntentCookie,
	isUserAllowed: isGithubOAuthLinkEnabledForUser,
})

/**
 * Clears the current session before the customer chooses the AI Hero login
 * that already owns the Discord account.
 */
export async function switchOAuthAccountLogin() {
	await switchLogin()
}

/**
 * Starts a Discord link from a fresh database session. The action accepts no
 * provider or user identity from the browser.
 */
export async function requestOAuthAccountLink() {
	const result = await requestDiscordLink()
	if (result.status === 'unauthenticated') {
		redirect('/login?callbackUrl=/discord')
	}
	if (result.status === 'linked') redirect('/discord/redirect')
	if (result.status !== 'ready') redirect('/discord?link=denied')

	await signIn('discord', { redirectTo: '/discord/redirect' })
	redirect('/discord?link=denied')
}

/**
 * Starts a GitHub link from a fresh database session. The action accepts no
 * provider or user identity from the browser and fails closed behind rollout.
 */
export async function requestGithubOAuthAccountLink() {
	const result = await requestGithubLink()
	if (result.status === 'unauthenticated') {
		redirect('/login?callbackUrl=/profile')
	}
	if (result.status === 'linked') redirect('/profile?link=linked')
	if (result.status === 'rollout-denied') {
		redirect('/profile?link=not-enabled')
	}
	if (result.status !== 'ready') redirect('/profile?link=denied')

	await signIn('github', { redirectTo: '/profile?link=linked' })
	redirect('/profile?link=denied')
}
