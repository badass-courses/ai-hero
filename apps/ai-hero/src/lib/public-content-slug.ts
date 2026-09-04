const UNSAFE_PUBLIC_CONTENT_SLUG_CHARACTER = /[\p{Cc}\p{Cs}\p{Co}]/u

/**
 * Reject route params that cannot be safe public content slugs.
 *
 * Valid Unicode remains unchanged, including format characters used by some
 * writing systems. Next 16.2.7 encodes those values in implicit cache tags; do
 * not replace this with an ASCII-only allowlist. The guard only rejects
 * controls, lone surrogates, and private-use characters. Those values cannot
 * name current published content, and control/private-use paths have produced
 * cache-tag failures in production.
 */
export function parsePublicContentSlug(value: string): string | null {
	if (
		!value ||
		value.includes('/') ||
		UNSAFE_PUBLIC_CONTENT_SLUG_CHARACTER.test(value)
	) {
		return null
	}

	return value
}
