const SITE_ORIGINS = ['https://www.aihero.dev', 'https://aihero.dev']

/**
 * Whether a POST came from one of our own pages. Mail gateways (Safe Links,
 * Proofpoint, Mimecast) fetch links, and a page elsewhere can post a form
 * at us; neither may act for a reader. Browsers send Origin on every form
 * POST, and Sec-Fetch-Site covers one that withholds it. Only the site's
 * origins (and its canonical URL) pass; an opaque `Origin: null` is
 * cross-site. Check this before reading anything else from the request.
 */
export function isSameOriginPost(
	request: Pick<Request, 'headers'>,
	canonicalUrl: string | undefined = process.env.NEXT_PUBLIC_URL,
): boolean {
	const origin = request.headers.get('origin')
	if (origin) {
		const allowed = new Set(SITE_ORIGINS)
		if (canonicalUrl) {
			try {
				allowed.add(new URL(canonicalUrl).origin)
			} catch {
				// An unparseable canonical URL adds nothing.
			}
		}
		return allowed.has(origin)
	}
	return request.headers.get('sec-fetch-site') === 'same-origin'
}
