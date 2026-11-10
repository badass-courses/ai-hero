/**
 * Plain, permissive shape check for a login email: one `@`, no spaces, and a
 * dot inside the domain with text on both sides. It only catches typos that
 * Postmark rejects with ErrorCode 300 (`a@b`, `name@gmailcom`), not
 * deliverability.
 */
export const INVALID_LOGIN_EMAIL_MESSAGE =
	"That email address doesn't look right. Please check it and try again."

export const INVALID_LOGIN_EMAIL_REDIRECT = '/error?error=EmailSignin'

export function isPlausibleLoginEmail(value: unknown): boolean {
	if (typeof value !== 'string') return false
	const email = value.trim()
	if (/\s/.test(email)) return false
	const parts = email.split('@')
	if (parts.length !== 2) return false
	const [local, domain] = parts as [string, string]
	if (!local) return false
	return /^[^.]+(\.[^.]+)+$/.test(domain)
}

type SignInInput = {
	user?: { email?: string | null }
	email?: { verificationRequest?: boolean }
}

/**
 * Wraps the Auth.js `signIn` callback so a magic-link request for a malformed
 * address redirects to the `EmailSignin` error view instead of reaching
 * Postmark, where the failure would surface as `Configuration`.
 */
export function withLoginEmailGuard<I>(
	next: (input: I) => Promise<boolean | string> | boolean | string,
) {
	return async (input: I & SignInInput): Promise<boolean | string> => {
		if (
			input?.email?.verificationRequest &&
			!isPlausibleLoginEmail(input.user?.email)
		) {
			return INVALID_LOGIN_EMAIL_REDIRECT
		}
		return next(input)
	}
}
