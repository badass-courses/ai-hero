/**
 * Hosts the OG image route may fetch from. next/og fetches every image URL
 * server-side, so an unlisted URL would let a caller, or anyone who can edit
 * a stored image field, make our function fetch any address (security desk
 * sec-039, 2026-11-21). Stored images use only these two hosts.
 */
export const OG_IMAGE_HOSTS = ['res.cloudinary.com', 'image.mux.com'] as const

/** The URL if it is https on an allowed host, else null. */
export function safeOgImageUrl(value: unknown): string | null {
	if (typeof value !== 'string' || !value) return null
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return null
	}
	if (url.protocol !== 'https:' || url.username || url.password) return null
	if (url.port && url.port !== '443') return null
	return (OG_IMAGE_HOSTS as readonly string[]).includes(url.hostname)
		? url.toString()
		: null
}
