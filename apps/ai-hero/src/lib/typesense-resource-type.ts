import type { ContentResource } from '@coursebuilder/core/schemas'

/**
 * The `type` a resource is indexed under in Typesense, which is what search
 * hits feed to `getResourcePath` — so getting it wrong produces broken links,
 * not just a wrong facet.
 *
 * `fields.postType` is the one legitimate override: a post with
 * `postType: 'skill'` is indexed as 'skill'. `fields.type` is NOT — on `list`
 * resources it carries the list's *flavour* ('nextUp' | 'tutorial' |
 * 'workshop'), so trusting it indexes a list as a workshop and sends
 * `/ai-engineering-crash-course~pniml` to `/workshops/...`.
 *
 * Kept dependency-free (and out of `typesense-query.ts`, which pulls in the
 * db and next-auth) so it stays unit-testable.
 */
export function deriveResourceType(resource: ContentResource): string {
	const postType = (resource?.fields as Record<string, any> | null | undefined)
		?.postType
	return postType || resource.type
}
