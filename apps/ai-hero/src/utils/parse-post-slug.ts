/**
 * Extracts a post slug from a URL or returns the input as a bare slug.
 *
 * Accepts:
 *   - https://www.aihero.dev/build-first-agent
 *   - https://www.aihero.dev/build-first-agent/
 *   - https://www.aihero.dev/md/build-first-agent
 *   - http://localhost:3000/build-first-agent
 *   - build-first-agent
 *   - /build-first-agent
 *
 * Returns null when the input does not yield a non-empty slug.
 */
export function parsePostSlug(input: string): string | null {
	const trimmed = input.trim()
	if (!trimmed) return null

	let pathname = trimmed
	if (/^https?:\/\//i.test(trimmed)) {
		try {
			pathname = new URL(trimmed).pathname
		} catch {
			return null
		}
	}

	pathname = pathname
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.replace(/^md\//, '')
		.replace(/\.md$/i, '')

	if (!pathname || pathname.includes('/')) {
		// No slug found, or input contained an unexpected nested path.
		// We deliberately reject nested paths because /artwork should target
		// a single post, not a collection or sub-resource.
		const segments = pathname.split('/').filter(Boolean)
		if (segments.length === 1) {
			return segments[0] ?? null
		}
		return null
	}

	return pathname
}
