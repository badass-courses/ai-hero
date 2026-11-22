type ResourceEdge = {
	resourceId: string
	resource?: { id: string; resources?: readonly ResourceEdge[] | null } | null
}

/**
 * Recursively collects **all** `resource.id`s contained within a `Workshop`.
 *
 * This includes:
 *  • Top-level resources that belong directly to the workshop (sections, lessons, posts, etc)
 *  • Any resources nested within sections (lessons, posts, etc)
 *  • Resources nested even deeper (solutions, videoResources, …) – the recursion doesn't care.
 *
 * NOTE: The returned list **does not** include the workshop id itself, only the child resources.
 *
 * @param workshop – Workshop membership tree (full or projected)
 * @returns A flat array of **unique** resource ids contained in the workshop.
 */
export function getWorkshopResourceIds(
	workshop: { resources: readonly ResourceEdge[] | null } | null | undefined,
): string[] {
	if (!workshop?.resources) return []

	const ids = new Set<string>()

	function traverse(resources: readonly ResourceEdge[]) {
		for (const mapping of resources) {
			// `mapping.resourceId` is the id of the child resource in the join table
			if (typeof mapping.resourceId === 'string') {
				ids.add(mapping.resourceId)
			}

			// The actual resource object is eager-loaded in the query
			const resource = mapping.resource
			if (resource) {
				// ensure we capture the id in case it differs (paranoia)
				if (typeof resource.id === 'string') {
					ids.add(resource.id)
				}

				// Recurse if the resource also has children (e.g. section → lessons, lesson → solutions)
				if (
					Array.isArray(resource.resources) &&
					resource.resources.length > 0
				) {
					traverse(resource.resources)
				}
			}
		}
	}

	traverse(workshop.resources)

	return Array.from(ids)
}
