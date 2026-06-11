import { describe, expect, it } from 'vitest'

import { groupWorkshopsByStartTime } from '../group-workshops-by-start-time'

// Minimal workshop factory for testing
function makeWorkshop(id: string, startsAt: string | null | undefined) {
	return {
		id,
		type: 'workshop' as const,
		fields: {
			title: `Workshop ${id}`,
			slug: `workshop-${id}`,
			startsAt: startsAt ?? undefined,
		},
	} as any
}

describe('groupWorkshopsByStartTime', () => {
	it('groups workshops with the same startsAt into one batch', () => {
		const workshops = [
			makeWorkshop('a', '2026-04-06T07:01:00.000Z'),
			makeWorkshop('b', '2026-04-06T07:01:00.000Z'),
			makeWorkshop('c', '2026-04-06T07:01:00.000Z'),
		]

		const groups = groupWorkshopsByStartTime(workshops)

		expect(groups.size).toBe(1)
		const batch = groups.get('2026-04-06T07:01:00.000Z')!
		expect(batch).toHaveLength(3)
		expect(batch.map((w) => w.id)).toEqual(['a', 'b', 'c'])
	})

	it('keeps workshops with different startsAt in separate groups', () => {
		const workshops = [
			makeWorkshop('a', '2026-03-30T07:01:00.000Z'),
			makeWorkshop('b', '2026-04-06T07:01:00.000Z'),
		]

		const groups = groupWorkshopsByStartTime(workshops)

		expect(groups.size).toBe(2)
		expect(groups.get('2026-03-30T07:01:00.000Z')).toHaveLength(1)
		expect(groups.get('2026-04-06T07:01:00.000Z')).toHaveLength(1)
	})

	it('single workshop per day produces a group of one (regression)', () => {
		const workshops = [makeWorkshop('solo', '2026-05-01T07:01:00.000Z')]

		const groups = groupWorkshopsByStartTime(workshops)

		expect(groups.size).toBe(1)
		const batch = groups.get('2026-05-01T07:01:00.000Z')!
		expect(batch).toHaveLength(1)
		expect(batch[0]!.id).toBe('solo')
	})

	it('skips workshops with null/undefined startsAt', () => {
		const workshops = [
			makeWorkshop('no-date-1', null),
			makeWorkshop('no-date-2', undefined),
			makeWorkshop('has-date', '2026-04-06T07:01:00.000Z'),
		]

		const groups = groupWorkshopsByStartTime(workshops)

		expect(groups.size).toBe(1)
		expect(groups.get('2026-04-06T07:01:00.000Z')).toHaveLength(1)
	})

	it('returns empty map for empty input', () => {
		const groups = groupWorkshopsByStartTime([])
		expect(groups.size).toBe(0)
	})

	it('handles mixed batches (real cohort scenario)', () => {
		const workshops = [
			makeWorkshop('day1', '2026-03-30T07:01:00.000Z'),
			makeWorkshop('day2', '2026-03-30T07:01:00.000Z'),
			makeWorkshop('day3', '2026-03-30T07:01:00.000Z'),
			makeWorkshop('day4', '2026-04-06T07:01:00.000Z'),
			makeWorkshop('day5', '2026-04-06T07:01:00.000Z'),
			makeWorkshop('day6', '2026-04-06T07:01:00.000Z'),
		]

		const groups = groupWorkshopsByStartTime(workshops)

		expect(groups.size).toBe(2)
		expect(groups.get('2026-03-30T07:01:00.000Z')).toHaveLength(3)
		expect(groups.get('2026-04-06T07:01:00.000Z')).toHaveLength(3)
	})
})
