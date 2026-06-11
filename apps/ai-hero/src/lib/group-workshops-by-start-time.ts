import type { Workshop } from '@/lib/workshops'

/**
 * Groups workshops by their startsAt time string.
 * Workshops with the same startsAt value end up in the same group.
 * This is used to batch email notifications for same-time workshops.
 */
export function groupWorkshopsByStartTime(
	workshops: Workshop[],
): Map<string, Workshop[]> {
	const groups = new Map<string, Workshop[]>()
	for (const workshop of workshops) {
		const key = workshop.fields.startsAt || ''
		if (!key) continue
		const group = groups.get(key) || []
		group.push(workshop)
		groups.set(key, group)
	}
	return groups
}
