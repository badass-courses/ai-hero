import { describe, expect, it } from 'vitest'

import {
	locateItem,
	nextPosition,
	siblingsOf,
	type MembershipRow,
} from './list-membership.service'

const LIST_ID = 'list-1'

const row = (
	resourceId: string,
	position: number,
	type = 'post',
	children?: MembershipRow[],
): MembershipRow => ({
	resourceId,
	position,
	resource: { id: resourceId, type, resources: children ?? null },
})

// A list holding one loose skill and a section with two skills inside it.
const rows: MembershipRow[] = [
	row('skill-loose', 0),
	row('section-1', 1, 'section', [row('skill-a', 0), row('skill-b', 1)]),
]

describe('locateItem', () => {
	it('finds a top-level item under the list itself', () => {
		expect(locateItem(LIST_ID, rows, 'skill-loose')).toEqual({
			parentId: LIST_ID,
			position: 0,
		})
	})

	it('finds an item nested in a section, under that section', () => {
		expect(locateItem(LIST_ID, rows, 'skill-b')).toEqual({
			parentId: 'section-1',
			position: 1,
		})
	})

	it('returns null for a resource the list does not hold', () => {
		expect(locateItem(LIST_ID, rows, 'skill-elsewhere')).toBeNull()
	})

	it('prefers the top-level row when a resource sits in both places', () => {
		// Legal in the data, and the list-level row is the one the editor shows —
		// so a remove must delete that one, not the nested copy.
		const both: MembershipRow[] = [
			row('skill-a', 0),
			row('section-1', 1, 'section', [row('skill-a', 0)]),
		]
		expect(locateItem(LIST_ID, both, 'skill-a')).toEqual({
			parentId: LIST_ID,
			position: 0,
		})
	})

	it('locates the section itself, which is a top-level item', () => {
		expect(locateItem(LIST_ID, rows, 'section-1')).toEqual({
			parentId: LIST_ID,
			position: 1,
		})
	})
})

describe('siblingsOf', () => {
	it('returns the list rows when the parent is the list', () => {
		expect(siblingsOf(LIST_ID, rows, LIST_ID)).toHaveLength(2)
	})

	it('returns a section’s children when the parent is that section', () => {
		expect(
			siblingsOf(LIST_ID, rows, 'section-1').map((r) => r.resourceId),
		).toEqual(['skill-a', 'skill-b'])
	})

	it('returns nothing for a parent the list does not hold', () => {
		expect(siblingsOf(LIST_ID, rows, 'section-elsewhere')).toEqual([])
	})

	it('returns nothing for a childless section', () => {
		expect(siblingsOf(LIST_ID, [row('section-2', 0, 'section')], 'section-2')).toEqual(
			[],
		)
	})
})

describe('nextPosition', () => {
	it('appends after the highest position, not the row count', () => {
		// Positions go sparse once things are removed; counting rows would
		// collide with an existing row and scramble the order.
		expect(nextPosition([row('a', 0), row('b', 7)])).toBe(8)
	})

	it('starts at 0 for an empty parent', () => {
		expect(nextPosition([])).toBe(0)
	})
})
