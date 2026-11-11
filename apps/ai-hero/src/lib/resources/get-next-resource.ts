'use server'

import { flattenNavigationResources } from '@/lib/content-navigation'
import { getCachedLesson } from '@/lib/lessons-query'
import { getCachedWorkshopNavigation } from '@/lib/workshops-query'

/**
 * Only what the prefetch hook reads. The full resource carried lesson and solution
 * bodies, drafts included, to anonymous callers (sec-20261111-006). Never widen this
 * without an entitlement check.
 */
export type NextResourcePointer = {
	id: string
	type: string
	fields: { slug: string | null }
}

export async function getNextResource(
	currentResourceId: string,
	moduleSlugOrId: string,
): Promise<NextResourcePointer | null> {
	const navigation = await getCachedWorkshopNavigation(moduleSlugOrId)

	const flattenedNavResources = flattenNavigationResources(navigation) || []

	const navIndex = flattenedNavResources.findIndex(
		(resource) => resource.id === currentResourceId,
	)

	// Unknown ids are a normal miss, not a server error.
	if (navIndex === -1) return null

	const nextResourceId = flattenedNavResources[navIndex + 1]?.id
	if (!nextResourceId) return null

	const next = await getCachedLesson(nextResourceId)
	if (!next) return null

	const slug = next.fields?.slug
	return {
		id: next.id,
		type: next.type,
		fields: { slug: typeof slug === 'string' ? slug : null },
	}
}
