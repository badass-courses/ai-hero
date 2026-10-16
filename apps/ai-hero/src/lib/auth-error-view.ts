/**
 * What the auth error page says for each code Auth.js can send to
 * `pages.error`. One exhaustive record plus one fallback: an unknown code, or
 * none, gets the generic view, and the raw `error` param is never rendered.
 */

export const AUTH_ERROR_CODES = [
	'Configuration',
	'AccessDenied',
	'Verification',
	'Signin',
	'OAuthSignin',
	'OAuthCallback',
	'OAuthCreateAccount',
	'EmailCreateAccount',
	'Callback',
	'OAuthAccountNotLinked',
	'EmailSignin',
	'CredentialsSignin',
	'SessionRequired',
	'Default',
] as const

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number]

export type AuthErrorAction = {
	label: string
	href: string
	variant?: 'default' | 'outline'
}

export type AuthErrorView = {
	title: string
	message: string
	/** Show the email login form on the page, so recovery is one step. */
	emailForm: boolean
	actions: AuthErrorAction[]
}

const EXPIRED_LINK: AuthErrorView = {
	title: 'This login link has expired or was already used',
	message:
		'Login links work once, and only for a short time. Enter your email to get a new one.',
	emailForm: true,
	actions: [],
}

const TRY_AGAIN: AuthErrorView = {
	title: 'Sign-in did not finish',
	message: 'That did not go through. Please try again.',
	emailForm: false,
	actions: [{ label: 'Try again', href: '/login', variant: 'default' }],
}

export const GENERIC_AUTH_ERROR: AuthErrorView = {
	title: 'We could not log you in',
	message:
		'Something went wrong while logging you in. Try again, or enter your email to get a new login link.',
	emailForm: true,
	actions: [],
}

export const AUTH_ERROR_VIEWS: Record<AuthErrorCode, AuthErrorView> = {
	Verification: EXPIRED_LINK,
	// Auth.js reports some spent or malformed email links as Configuration; to
	// the person holding the link it reads the same as an expired one.
	Configuration: {
		...GENERIC_AUTH_ERROR,
		message:
			'We could not finish that login. If you used a login link, it may have expired or already been used. Enter your email to get a new one.',
	},
	AccessDenied: {
		title: 'Access denied',
		message:
			'That account is not allowed to log in. If you think that is a mistake, contact support.',
		emailForm: false,
		actions: [{ label: 'Back to login', href: '/login', variant: 'default' }],
	},
	EmailSignin: {
		title: 'We could not send that login link',
		message:
			'The email did not go out. Check the address and try again, or contact support.',
		emailForm: true,
		actions: [],
	},
	OAuthAccountNotLinked: {
		title: 'Account linking failed',
		message:
			"Your GitHub or Discord email doesn't match the email on your existing account, so we couldn't connect them. Log in with your email first, then connect the provider from your profile.",
		emailForm: true,
		actions: [{ label: 'Go to profile', href: '/profile', variant: 'outline' }],
	},
	OAuthCallback: {
		...TRY_AGAIN,
		title: 'Sign-in interrupted',
		message:
			'The sign-in was interrupted, maybe because the page was refreshed or the session timed out. Please try again.',
	},
	OAuthSignin: {
		...TRY_AGAIN,
		title: 'Could not start sign-in',
		message:
			"We couldn't send you to the sign-in provider. This is usually temporary, please try again.",
	},
	OAuthCreateAccount: TRY_AGAIN,
	EmailCreateAccount: TRY_AGAIN,
	Callback: TRY_AGAIN,
	Signin: TRY_AGAIN,
	CredentialsSignin: TRY_AGAIN,
	SessionRequired: {
		title: 'Log in to continue',
		message: 'You need to be logged in to see that page.',
		emailForm: true,
		actions: [],
	},
	Default: GENERIC_AUTH_ERROR,
}

function isAuthErrorCode(code: string): code is AuthErrorCode {
	return Object.hasOwn(AUTH_ERROR_VIEWS, code)
}

/** The code is kept for logs only when it is one we know; never echoed. */
export function authErrorView(code: string | null | undefined): AuthErrorView {
	if (!code || !isAuthErrorCode(code)) return GENERIC_AUTH_ERROR
	return AUTH_ERROR_VIEWS[code]
}

export function knownAuthErrorCode(
	code: string | null | undefined,
): AuthErrorCode | null {
	return code && isAuthErrorCode(code) ? code : null
}
