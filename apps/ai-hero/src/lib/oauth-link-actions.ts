'use server'

export type OAuthAccountLinkRequestResult = {
	status: 'disabled'
}

/**
 * Explicit provider linking is disabled until a persisted, session-bound,
 * one-use intent can be verified during the OAuth callback.
 */
export async function requestOAuthAccountLink(): Promise<OAuthAccountLinkRequestResult> {
	return { status: 'disabled' }
}
