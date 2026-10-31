/**
 * Redirect URI policy for the learner OAuth server. HTTPS anywhere, or
 * plain HTTP to a loopback host only (MCP authorization spec). No fragment,
 * no userinfo. Matching is exact, except that a loopback redirect may use
 * any port (OAuth 2.1 §8.4.2 / RFC 8252 §7.3): native clients bind an
 * ephemeral port at sign-in time.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const MAX_REDIRECT_URI_LENGTH = 512

function parse(uri: string): URL | null {
	if (uri.length > MAX_REDIRECT_URI_LENGTH) return null
	try {
		return new URL(uri)
	} catch {
		return null
	}
}

export function isLoopbackRedirect(url: URL) {
	return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

/** Whether `uri` may be registered as a redirect URI at all. */
export function isAllowedRedirectUri(uri: unknown): uri is string {
	if (typeof uri !== 'string') return false
	const url = parse(uri)
	if (!url) return false
	if (url.hash || uri.includes('#')) return false
	if (url.username || url.password) return false
	if (url.protocol === 'https:') return Boolean(url.hostname)
	return isLoopbackRedirect(url)
}

/** Whether the requested redirect URI is one the client registered. */
export function matchesRegisteredRedirect(
	registered: ReadonlyArray<string>,
	requested: string,
) {
	if (!isAllowedRedirectUri(requested)) return false
	if (registered.includes(requested)) return true
	const asked = parse(requested)
	if (!asked || !isLoopbackRedirect(asked)) return false
	return registered.some((candidate) => {
		const known = parse(candidate)
		if (!known || !isLoopbackRedirect(known)) return false
		known.port = ''
		const withoutPort = new URL(asked.href)
		withoutPort.port = ''
		return known.href === withoutPort.href
	})
}

/** What the consent page shows: the host the code will be sent to. */
export function redirectDisplay(uri: string) {
	const url = new URL(uri)
	return { host: url.host, loopback: isLoopbackRedirect(url) }
}
