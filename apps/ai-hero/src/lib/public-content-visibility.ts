import type { Metadata } from 'next'

type VisibilityFields =
	| { state?: string | null; visibility?: string | null }
	| null
	| undefined

/**
 * True when the public post or workshop route must 404 for everyone.
 *
 * Archived means retired, and private means the author chose owner-only.
 * Both used to render their full body to anonymous visitors (security desk
 * sec-041, 2026-11-21). These routes are static, so they cannot check who is
 * asking; authors keep seeing the resource in its editor.
 *
 * Drafts are not withheld here: unlisted drafts are delivered content for
 * published cohorts and pre-launch landing pages, and real readers reach
 * them by link. That decision sits with the Switchboard (sec-041).
 */
export function isWithheldFromPublicRoute(fields: VisibilityFields): boolean {
	return fields?.state === 'archived' || fields?.visibility === 'private'
}

/** Search engines index only published resources. */
export function publicRouteRobots(
	fields: VisibilityFields,
): Metadata['robots'] | undefined {
	return fields?.state === 'published'
		? undefined
		: { index: false, follow: false }
}
