/**
 * `fields.icon.url` → a url an `<img>` can actually load, or undefined.
 *
 * `fields` is raw JSON on most read paths, so a malformed url written past
 * PostSchema (e.g. via the passthrough /api/resources) would make next/image
 * throw and take the whole page with it. Same http(s)/rooted-path heuristic as
 * the kit's ImageField. Shared by the /skills catalog and the skill page head
 * so the two surfaces never disagree about which icons exist.
 */
export function skillIconUrl(
	fields: Record<string, unknown> | null | undefined,
): string | undefined {
	const icon = fields?.icon as { url?: unknown } | null | undefined
	if (typeof icon?.url !== 'string') return undefined
	return /^https?:\/\//i.test(icon.url) || icon.url.startsWith('/')
		? icon.url
		: undefined
}
