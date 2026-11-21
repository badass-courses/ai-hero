/**
 * The only URL `certificate.upload` may fetch: our own certificate render for
 * the signed-in learner. It used to fetch any caller-supplied URL, twice
 * (once directly, once through Cloudinary), from a public procedure, and
 * reflect the upstream error body (security desk sec-043, 2026-11-21).
 * Built on the server from the session user, so a caller can neither point
 * it elsewhere nor store an image under another learner's certificate.
 */
export function certificateRenderUrl(
	baseUrl: string,
	resourceIdOrSlug: string,
	userId: string,
): string {
	const url = new URL('/api/certificates', baseUrl)
	url.searchParams.set('resource', resourceIdOrSlug)
	url.searchParams.set('user', userId)
	return url.toString()
}
