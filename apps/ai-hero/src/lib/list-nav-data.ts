import type { List } from '@/lib/lists'

/**
 * Projects a list down to what the client-side list navigation renders.
 *
 * The list crosses the server/client boundary once, in `ListProvider`, and
 * every consumer of that context (`useList`) draws navigation: lesson rows,
 * the series pager, the mobile lesson sheet. They read ids, slugs, titles,
 * ordering and publish state — never a resource's `body`.
 *
 * The unprojected list serializes the full CMS row of every member into every
 * page of the list. On the skills catalog that was ~70 kB of raw markdown
 * bodies (plus descriptions and audit columns) repeated on each of the 22
 * skill pages — the single largest block of the 430 kB documents from the
 * 2026-08-03 slow-site report.
 */
export function toListNavData(list: List): List
export function toListNavData(list: List | null): List | null
export function toListNavData(list: List | null): List | null {
	if (!list) return null

	return {
		...list,
		fields: {
			title: list.fields.title,
			slug: list.fields.slug,
			type: list.fields.type,
			state: list.fields.state,
			visibility: list.fields.visibility,
		},
		resources: (list.resources ?? []).map(slimWrapper),
		// Tag rows carry their own full CMS fields and nothing in the nav reads
		// them.
		tags: [],
	}
}

/** A `contentResourceResource` join row: ordering plus the resource itself. */
function slimWrapper(wrapper: any): any {
	return {
		resourceId: wrapper?.resourceId,
		position: wrapper?.position,
		resource: wrapper?.resource ? slimResource(wrapper.resource) : undefined,
	}
}

/**
 * A list member: identity, the fields the nav rows render, and — for section
 * resources — the nested members, slimmed the same way.
 */
function slimResource(resource: any): any {
	return {
		id: resource.id,
		type: resource.type,
		fields: {
			slug: resource.fields?.slug,
			title: resource.fields?.title,
			state: resource.fields?.state,
		},
		...(Array.isArray(resource.resources)
			? { resources: resource.resources.map(slimWrapper) }
			: {}),
	}
}
