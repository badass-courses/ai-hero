import { type List } from '@/lib/lists'

/**
 * Flatten a list's top-level resources, descending into sections so that the
 * resources nested inside a section are surfaced in reading order. This mirrors
 * how the navigation renders sectioned lists, so "next up" walks across section
 * boundaries instead of only seeing top-level rows.
 */
export function flattenListResources(list: List | null) {
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

/** One end of the lesson pager: enough to render a row, nothing more. */
export type ListNeighbor = {
	id: string
	title: string
	slug: string
	/** 1-based position in the flattened list, for "lesson 02". */
	position: number
}

/**
 * Previous / next lesson around `currentResourceId`, in the same flattened
 * reading order `getNextUpResourceFromList` walks.
 *
 * Published-state and slug checks live here so callers can treat a neighbour as
 * "renderable or absent" rather than re-deriving that per surface.
 */
export function getListNeighborsFromList(
	list: List | null,
	currentResourceId: string,
): { prev: ListNeighbor | null; next: ListNeighbor | null; total: number } {
	const flattened = flattenListResources(list)
	const currentIndex = flattened.findIndex(
		(r) => r.resource.id === currentResourceId,
	)

	if (currentIndex === -1) {
		return { prev: null, next: null, total: flattened.length }
	}

	const toNeighbor = (index: number): ListNeighbor | null => {
		const wrapper = flattened[index]
		const resource = wrapper?.resource as any
		if (!resource) return null
		if (resource.fields?.state && resource.fields.state !== 'published') {
			return null
		}
		const slug = resource.fields?.slug
		if (typeof slug !== 'string' || !slug) return null
		return {
			id: resource.id,
			title: String(resource.fields?.title ?? 'Untitled'),
			slug,
			position: index + 1,
		}
	}

	// Step OUTWARD until something renderable turns up, rather than looking at
	// the one adjacent slot. `toNeighbor` rejects a resource that is unpublished
	// or has no slug — both are ordinary states for a list still being written —
	// and checking only `index ± 1` meant a single draft parked between two
	// published lessons removed "Up next" from the lesson before it. The reader
	// hit what looked like the end of the list in the middle of it.
	const findNeighbor = (
		startIndex: number,
		step: -1 | 1,
	): ListNeighbor | null => {
		for (
			let index = startIndex;
			index >= 0 && index < flattened.length;
			index += step
		) {
			const neighbor = toNeighbor(index)
			if (neighbor) return neighbor
		}
		return null
	}

	return {
		prev: findNeighbor(currentIndex - 1, -1),
		next: findNeighbor(currentIndex + 1, 1),
		total: flattened.length,
	}
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
