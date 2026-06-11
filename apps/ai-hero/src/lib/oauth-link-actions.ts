'use server'

import { cookies } from 'next/headers'
import {
	getOAuthLinkCookieName,
	type ConnectableOAuthProvider,
} from '@/lib/oauth-link-cookie'

/**
 * Set a secure cookie with the current user's ID before the OAuth redirect.
 * This ensures we can link the provider account to the correct user even if
 * the session cookie is lost during the OAuth round-trip.
 */
export async function setOAuthLinkingCookie(
	userId: string,
	provider: ConnectableOAuthProvider,
) {
	const cookieStore = await cookies()
	cookieStore.set(getOAuthLinkCookieName(provider), userId, {
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'lax',
		maxAge: 600,
		path: '/',
	})
}
