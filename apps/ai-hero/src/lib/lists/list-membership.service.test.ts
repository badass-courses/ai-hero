import { describe, expect, it } from 'vitest'

import { MoveListItemsInputSchema } from './list-membership-contracts'
import {
	ListMembershipError,
	locateItem,
	nextPosition,
	planMoves,
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

describe('planMoves', () => {
	const tree = (): MembershipRow[] => [
		row('skill-loose', 0),
		row('section-1', 1, 'section', [row('skill-a', 0), row('skill-b', 1)]),
		row('section-2', 2, 'section', [row('skill-c', 0)]),
	]

	const errorCode = (fn: () => unknown) => {
		try {
			fn()
		} catch (error) {
			if (error instanceof ListMembershipError) return error.code
			throw error
		}
		return null
	}

	it('renumbers every touched parent densely, siblings included', () => {
		// Moving skill-b to the front of section-1 must also push skill-a's
		// position — the batch never named skill-a, but the write does.
		const writes = planMoves(LIST_ID, tree(), [
			{ resourceId: 'skill-b', position: 0 },
		])
		expect(writes).toEqual([
			{
				resourceId: 'skill-b',
				fromParentId: 'section-1',
				toParentId: 'section-1',
				position: 0,
			},
			{
				resourceId: 'skill-a',
				fromParentId: 'section-1',
				toParentId: 'section-1',
				position: 1,
			},
		])
	})

	it('compacts sparse positions instead of preserving the gaps', () => {
		// Removes never renumbered, so stored positions drift sparse. Any move
		// through this planner leaves the touched parents dense again.
		const sparse: MembershipRow[] = [
			row('section-1', 0, 'section', [row('skill-a', 3), row('skill-b', 9)]),
		]
		const writes = planMoves(LIST_ID, sparse, [
			{ resourceId: 'skill-b', position: 0 },
		])
		expect(writes).toEqual([
			expect.objectContaining({ resourceId: 'skill-b', position: 0 }),
			expect.objectContaining({ resourceId: 'skill-a', position: 1 }),
		])
	})

	it('clamps a position past the end to an append', () => {
		const writes = planMoves(LIST_ID, tree(), [
			{ resourceId: 'skill-loose', parentId: 'section-1', position: 99 },
		])
		expect(writes).toContainEqual({
			resourceId: 'skill-loose',
			fromParentId: LIST_ID,
			toParentId: 'section-1',
			position: 2,
		})
	})

	it('moves between sections and renumbers both sides', () => {
		const writes = planMoves(LIST_ID, tree(), [
			{ resourceId: 'skill-a', parentId: 'section-2', position: 0 },
		])
		expect(writes).toContainEqual(
			expect.objectContaining({
				resourceId: 'skill-a',
				toParentId: 'section-2',
				position: 0,
			}),
		)
		// skill-b closes the gap skill-a left; skill-c yields the front slot.
		expect(writes).toContainEqual(
			expect.objectContaining({ resourceId: 'skill-b', position: 0 }),
		)
		expect(writes).toContainEqual(
			expect.objectContaining({ resourceId: 'skill-c', position: 1 }),
		)
	})

	it('rejects a parent that is not a section', () => {
		expect(
			errorCode(() =>
				planMoves(LIST_ID, tree(), [
					{ resourceId: 'skill-a', parentId: 'skill-loose', position: 0 },
				]),
			),
		).toBe('PARENT_NOT_A_SECTION')
	})

	it('rejects nesting a section inside a section, and thereby itself', () => {
		expect(
			errorCode(() =>
				planMoves(LIST_ID, tree(), [
					{ resourceId: 'section-1', parentId: 'section-2', position: 0 },
				]),
			),
		).toBe('SECTION_NESTING')
		// Self-parenting is the same shape: the moved row would have to be a
		// section (only sections parent), and sections never nest.
		expect(
			errorCode(() =>
				planMoves(LIST_ID, tree(), [
					{ resourceId: 'section-1', parentId: 'section-1', position: 0 },
				]),
			),
		).toBe('SECTION_NESTING')
	})

	it('rejects a destination that already holds the resource', () => {
		// Legal duplicate placement: skill-c sits at top level AND in
		// section-2. Moving the top-level copy into section-2 would collide
		// with the membership key.
		const withDuplicate: MembershipRow[] = [
			row('skill-c', 0),
			row('section-2', 1, 'section', [row('skill-c', 0)]),
		]
		expect(
			errorCode(() =>
				planMoves(LIST_ID, withDuplicate, [
					{ resourceId: 'skill-c', parentId: 'section-2', position: 1 },
				]),
			),
		).toBe('RESOURCE_ALREADY_IN_LIST')
	})

	it('rejects a resource the list does not hold', () => {
		expect(
			errorCode(() =>
				planMoves(LIST_ID, tree(), [
					{ resourceId: 'skill-elsewhere', position: 0 },
				]),
			),
		).toBe('RESOURCE_NOT_IN_LIST')
	})

	it('emits nothing when the batch changes nothing', () => {
		// skill-a is already at position 0 of section-1 in a dense parent.
		expect(
			planMoves(LIST_ID, tree(), [{ resourceId: 'skill-a', position: 0 }]),
		).toEqual([])
	})
})

describe('MoveListItemsInputSchema', () => {
	it('rejects the same resourceId twice in one batch', () => {
		// The second entry would be planned against row state the first already
		// changed, and the response would report a move that never happened.
		const parsed = MoveListItemsInputSchema.safeParse({
			items: [
				{ resourceId: 'skill-a', position: 0 },
				{ resourceId: 'skill-a', position: 2 },
			],
		})
		expect(parsed.success).toBe(false)
	})
})
