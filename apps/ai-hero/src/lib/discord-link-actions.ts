'use server'

import { setOAuthLinkingCookie } from '@/lib/oauth-link-actions'

export async function setDiscordLinkingCookie(userId: string) {
	return setOAuthLinkingCookie(userId, 'discord')
}
