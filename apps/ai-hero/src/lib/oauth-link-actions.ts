'use server'

import { randomBytes } from 'node:crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { courseBuilderAdapter, db } from '@/db'
import { accounts } from '@/db/schema'
import {
	clearLegacyOAuthLinkCookies,
	writeOAuthLinkIntentCookie,
} from '@/lib/oauth-link-cookie'
import { redactOAuthLinkRef } from '@/server/oauth-link-intent'
import { oauthLinkIntentService } from '@/server/oauth-link-intent-drizzle'
import { observeOAuthLinkCanary } from '@/server/oauth-link-observability'
import { isDiscordRelinkEnabledForUser } from '@/server/oauth-link-rollout'
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
	isUserAllowed: isDiscordRelinkEnabledForUser,
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
	if (result.status === 'rollout-denied') {
		const flowId = `olf_gate_${randomBytes(12).toString('base64url')}`
		const common = {
			flowId,
			provider: 'discord' as const,
			targetUserRef: redactOAuthLinkRef(result.targetUserId),
			reasonClass: 'rollout-denied' as const,
		}
		await observeOAuthLinkCanary({
			...common,
			action: 'validation_denied',
			result: 'denied',
		})
		await observeOAuthLinkCanary({
			...common,
			action: 'flow_completed',
			result: 'denied',
		})
		redirect('/discord?link=denied')
	}
	if (result.status === 'denied') redirect('/discord?link=denied')

	await signIn('discord', { redirectTo: '/discord/redirect' })
	redirect('/discord?link=denied')
}
