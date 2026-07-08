import type { ContentResourceResource } from '@coursebuilder/core/schemas'

/**
 * Shared visibility rules for rendering a list's contents publicly (used by the
 * list landing; the workshop surfaces gate on ability instead). Kept in one
 * place so every list surface treats sections and their children identically.
 */

type Fields = Record<string, unknown> | null | undefined

/**
 * A leaf resource (skill/post/lesson) shows only when it's published and not
 * hidden from listings — i.e. not `unlisted` or `private`. A missing
 * visibility is treated as public (legacy rows never got the field).
 */
export function isDisplayable(fields: Fields): boolean {
	const visibility = fields?.visibility
	return (
		fields?.state === 'published' &&
		visibility !== 'unlisted' &&
		visibility !== 'private'
	)
}

/**
 * Trim a list's deep child rows down to what should render publicly: loose
 * displayable items pass through; a `section` is purely structural (its own
 * state/visibility is ignored) and keeps only its displayable children, dropped
 * entirely when none remain (no orphan heading). The nested
 * `ContentResourceResource` shape is preserved so the result feeds straight
 * into `ResourceListView` (the same component workshops use).
 */
export function filterSectionedResources(
	resources?: ContentResourceResource[] | null,
): ContentResourceResource[] {
	const out: ContentResourceResource[] = []
	for (const row of resources ?? []) {
		const resource = row?.resource
		if (!resource) continue

		if (resource.type === 'section') {
			const children = (resource.resources ?? []).filter(
				(child: ContentResourceResource) =>
					isDisplayable(child?.resource?.fields),
			)
			if (children.length === 0) continue
			out.push({ ...row, resource: { ...resource, resources: children } })
			continue
		}

		if (!isDisplayable(resource.fields)) continue
		out.push(row)
	}
	return out
}

/** First displayable leaf slug — the list's "Start Learning" target. */
export function firstDisplayableSlug(
	resources?: ContentResourceResource[] | null,
): string | undefined {
	for (const row of resources ?? []) {
		const resource = row?.resource
		if (resource?.type === 'section') {
			const slug = resource.resources?.[0]?.resource?.fields?.slug
			if (typeof slug === 'string' && slug) return slug
		} else {
			const slug = resource?.fields?.slug
			if (typeof slug === 'string' && slug) return slug
		}
	}
	return undefined
}
