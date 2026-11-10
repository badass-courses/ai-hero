/**
 * Customer-facing copy for the OAuth consent page, in one place for review.
 * No em dashes (DESIGN.md bans).
 */
export const CONSENT_COPY = {
	metaTitle: 'Connect your agent',
	title: (client: string) => `Connect ${client} to AI Hero`,
	scopeLine: (client: string) =>
		`${client} will be able to read your AI Hero courses as you: what you own, your lessons and what you've finished. It can't buy, change or post anything.`,
	redirectLabel: 'After you approve, you go back to',
	loopbackWarning:
		'This app runs on your own computer. Only approve if you started this sign-in yourself just now.',
	accountLabel: 'Signed in as',
	lifetime: 'Access lasts 90 days.',
	approve: 'Approve',
	deny: 'Deny',
	errorTitle: 'We couldn’t connect your app',
} as const

const ERROR_MESSAGES: Record<string, string> = {
	invalid_client:
		'We couldn’t verify this app. Go back to it and try connecting again.',
	invalid_redirect_uri:
		'This app asked to send you to an address it didn’t register, so we stopped here.',
	expired: 'This sign-in took too long. Go back to your app and connect again.',
	wrong_account:
		'You’re signed in to a different AI Hero account than the one that started this sign-in. Go back to your app and connect again.',
	rate_limited: 'Too many sign-in attempts. Wait a minute, then try again.',
	unavailable: 'Sign-in is unavailable right now. Try again in a few minutes.',
}

export const consentErrorMessage = (reason: string) =>
	ERROR_MESSAGES[reason] ??
	'Something went wrong with this sign-in. Go back to your app and try again.'
