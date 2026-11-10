/**
 * The emailed login link carries its secrets in the URL fragment. A fragment is
 * never sent to the server, so the token and the email stay out of every
 * request log (the app's and the platform's), `Referer` header and cache key.
 *
 * Pure and dependency-free so the email sender, the verify page and the
 * confirm route can all share it.
 */

const MAGIC_LINK_CALLBACK_PATH = '/api/auth/callback/postmark'
export const MAGIC_LINK_VERIFY_PATH = '/login/verify'
export const MAGIC_LINK_FRAGMENT_STORAGE_KEY = 'aih:magic-link-fragment'

/**
 * Parser-blocking inline script, first in the root head. Do not defer this to
 * hydration or a React effect: analytics can read location before either runs.
 * Storage can be disabled; stripping the URL still takes priority over login.
 */
export const MAGIC_LINK_FRAGMENT_BOOTSTRAP = `(function () {
  if (window.location.pathname !== '/login/verify') return;
  var hash = window.location.hash;
  try {
    window.sessionStorage.removeItem('aih:magic-link-fragment');
    if (hash) window.sessionStorage.setItem('aih:magic-link-fragment', hash);
  } catch (_) {}
  if (hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
})();`

export type MagicLinkFragment = {
	token: string
	email: string
	callbackUrl: string | null
}

/**
 * Rewrites the Auth.js-built callback link (`/api/auth/callback/postmark?...`)
 * to `<origin>/login/verify#token=...&email=...&callbackUrl=...`. Any other
 * URL, or a callback link without token and email, is returned unchanged.
 */
export function toFragmentLoginUrl(url: string): string {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return url
	}
	if (parsed.pathname !== MAGIC_LINK_CALLBACK_PATH) return url
	const token = parsed.searchParams.get('token')
	const email = parsed.searchParams.get('email')
	if (!token || !email) return url
	const fragment = new URLSearchParams({ token, email })
	const callbackUrl = parsed.searchParams.get('callbackUrl')
	if (callbackUrl) fragment.set('callbackUrl', callbackUrl)
	return `${parsed.origin}${MAGIC_LINK_VERIFY_PATH}#${fragment.toString()}`
}

/** Reads `location.hash`; null when it does not carry a token and an email. */
export function readMagicLinkFragment(hash: string): MagicLinkFragment | null {
	const params = new URLSearchParams(hash.replace(/^#/, ''))
	const token = params.get('token')
	const email = params.get('email')
	if (!token || !email) return null
	return { token, email, callbackUrl: params.get('callbackUrl') || null }
}

type FragmentWindow = {
	location: { hash: string; pathname: string; search: string }
	sessionStorage?: Pick<Storage, 'getItem' | 'removeItem'>
	history: {
		state: unknown
		replaceState: (state: unknown, unused: string, url: string) => void
	}
}

/** Consumes the early head script's handoff once, with a direct-hash fallback. */
export function consumeMagicLinkFragment(
	win: FragmentWindow,
): MagicLinkFragment | null {
	let stored: string | null = null
	try {
		stored = win.sessionStorage?.getItem(MAGIC_LINK_FRAGMENT_STORAGE_KEY) ?? null
		win.sessionStorage?.removeItem(MAGIC_LINK_FRAGMENT_STORAGE_KEY)
	} catch {
		// The bootstrap already stripped the URL even if storage is unavailable.
	}
	const hash = win.location.hash || stored || ''
	if (win.location.hash) {
		win.history.replaceState(
			win.history.state,
			'',
			`${win.location.pathname}${win.location.search}`,
		)
	}
	return readMagicLinkFragment(hash)
}
