/**
 * Pure assembly half of the flat navigation loader
 * (`content-navigation-query.ts`): the level queries return flat join rows,
 * and these helpers nest them back into the wrapper tree
 * `ResourceNavigationSchema` validates. Separate module because the query
 * file is `'use server'` — anything exported from there becomes a Server
 * Action endpoint, and these need to be plain testable functions.
 */

/** One flat row: a `contentResourceResource` join row plus its resource. */
export type NavigationTreeRow = {
	resourceId: string
	resourceOfId: string
	position: number
	metadata: Record<string, any> | null
	createdAt: Date | null
	updatedAt: Date | null
	deletedAt: Date | null
	resource: {
		id: string
		type: string
		createdById: string
		currentVersionId: string | null
		createdAt: Date | null
		updatedAt: Date | null
		deletedAt: Date | null
		fields: string | Record<string, any> | null
	}
}

/**
 * `JSON_OBJECT` in the select gives `null` for keys the row's `fields` never
 * had (and mysql2 may hand the computed object back as a string). The old
 * strip pass omitted absent keys and returned null for an empty result —
 * preserve both so the parsed shape is unchanged.
 */
export function cleanNavigationFields(
	raw: string | Record<string, any> | null,
): Record<string, any> | null {
	const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
	if (!parsed) return null
	const cleaned: Record<string, any> = {}
	for (const [key, value] of Object.entries(parsed)) {
		if (value !== null && value !== undefined) cleaned[key] = value
	}
	return Object.keys(cleaned).length > 0 ? cleaned : null
}

/** Index flat rows by their parent, preserving each level's query order. */
export function groupNavigationRows(
	rows: NavigationTreeRow[],
): Map<string, NavigationTreeRow[]> {
	const byParent = new Map<string, NavigationTreeRow[]>()
	for (const row of rows) {
		const siblings = byParent.get(row.resourceOfId)
		if (siblings) siblings.push(row)
		else byParent.set(row.resourceOfId, [row])
	}
	return byParent
}

/**
 * Nest the grouped rows into wrapper shape, `depth` levels below `parentId`.
 * The leaf level carries no `resources` key — same as the relational query's
 * deepest `resource: true` used to produce.
 */
export function buildNavigationTree(
	byParent: Map<string, NavigationTreeRow[]>,
	parentId: string,
	depth: number,
): any[] {
	return (byParent.get(parentId) ?? []).map((row) => ({
		...row,
		resource: {
			...row.resource,
			fields: cleanNavigationFields(row.resource.fields),
			...(depth > 1
				? {
						resources: buildNavigationTree(
							byParent,
							row.resourceId,
							depth - 1,
						),
					}
				: {}),
		},
	}))
}
