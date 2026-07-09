import { type List } from '@/lib/lists'

/**
 * Flatten a list's top-level resources, descending into sections so that the
 * resources nested inside a section are surfaced in reading order. This mirrors
 * how the navigation renders sectioned lists, so "next up" walks across section
 * boundaries instead of only seeing top-level rows.
 */
function flattenListResources(list: List | null) {
	const flattened: NonNullable<List['resources']> = []

	for (const wrapper of list?.resources ?? []) {
		if (wrapper.resource.type === 'section' && wrapper.resource.resources) {
			for (const child of wrapper.resource.resources) {
				flattened.push(child)
			}
		} else {
			flattened.push(wrapper)
		}
	}

	return flattened
}

export function getNextUpResourceFromList(
	list: List | null,
	currentResourceId: string,
) {
	const flattened = flattenListResources(list)

	const currentIndex = flattened.findIndex(
		(r) => r.resource.id === currentResourceId,
	)

	if (currentIndex === -1) return null

	const nextUpResource = flattened[currentIndex + 1]

	return nextUpResource || null
}
