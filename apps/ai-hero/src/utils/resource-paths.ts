import {
	getResourcePath as baseGetResourcePath,
	type ResourceContext,
} from '@coursebuilder/utils/resource-paths'

/**
 * App-side `getResourcePath` with a 'skill' entry.
 *
 * Typesense docs carry `type = fields.postType` for posts, so a
 * `postType: 'skill'` post surfaces in search hits as type 'skill'. The
 * shared `@coursebuilder/utils` path map has no 'skill' entry (adding one
 * needs a package publish), and its unknown-type fallback produces
 * `/skill/<slug>` — a broken link. Skill posts are ordinary posts: flat root
 * view URL, `/posts/<slug>/edit` edit URL.
 *
 * Use this wrapper anywhere a search/Typesense hit's type feeds an href;
 * every other type delegates to the package implementation unchanged.
 */
export function getResourcePath(
	type: string,
	slug: string,
	mode: 'edit' | 'view' = 'view',
	context?: ResourceContext,
): string {
	if (type === 'skill') {
		return mode === 'edit' ? `/posts/${slug}/edit` : `/${slug}`
	}
	return baseGetResourcePath(type, slug, mode, context)
}
