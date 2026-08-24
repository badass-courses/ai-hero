import type { Account } from '@auth/core/types'

export const OAUTH_PROVIDER_ACCOUNT_LINKED_EVENT =
	'user/oauth-provider-account-linked'

export type OAuthProviderAccountReference = Pick<
	Account,
	'provider' | 'providerAccountId'
>

export function toOAuthProviderAccountReference(
	account: OAuthProviderAccountReference,
): OAuthProviderAccountReference {
	return {
		provider: account.provider,
		providerAccountId: account.providerAccountId,
	}
}

export type OauthProviderAccountLinked = {
	name: typeof OAUTH_PROVIDER_ACCOUNT_LINKED_EVENT
	data: {
		account: OAuthProviderAccountReference
		flowId?: string
	}
}
