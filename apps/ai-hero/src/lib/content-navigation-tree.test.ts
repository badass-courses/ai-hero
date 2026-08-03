import { describe, expect, it } from 'vitest'

import {
	buildNavigationTree,
	cleanNavigationFields,
	groupNavigationRows,
	type NavigationTreeRow,
} from './content-navigation-tree'

const row = (
	resourceOfId: string,
	resourceId: string,
	position: number,
	type: string,
	fields: NavigationTreeRow['resource']['fields'],
): NavigationTreeRow => ({
	resourceId,
	resourceOfId,
	position,
	metadata: null,
	createdAt: new Date('2026-01-01'),
	updatedAt: null,
	deletedAt: null,
	resource: {
		id: resourceId,
		type,
		createdById: 'user-1',
		currentVersionId: null,
		createdAt: new Date('2026-01-01'),
		updatedAt: null,
		deletedAt: null,
		fields,
	},
})

describe('cleanNavigationFields', () => {
	it('parses the string mysql2 hands back for computed JSON', () => {
		expect(cleanNavigationFields('{"slug":"a","title":"A"}')).toEqual({
			slug: 'a',
			title: 'A',
		})
	})

	it('omits keys JSON_OBJECT nulled for absent fields, like the old strip pass', () => {
		expect(
			cleanNavigationFields({ slug: 'a', title: null, state: null }),
		).toEqual({ slug: 'a' })
	})

	it('returns null for an empty result, like stripHeavyFields did', () => {
		expect(cleanNavigationFields({ title: null })).toBeNull()
		expect(cleanNavigationFields(null)).toBeNull()
	})
})

describe('buildNavigationTree', () => {
	// workshop → section → lesson → solution: the three levels below the root
	// the old relational query loaded.
	const rows = [
		row('workshop-1', 'section-1', 0, 'section', { slug: 's-1' }),
		row('workshop-1', 'section-2', 1, 'section', { slug: 's-2' }),
		row('section-1', 'lesson-1', 0, 'lesson', { slug: 'l-1' }),
		row('section-1', 'lesson-2', 1, 'lesson', { slug: 'l-2' }),
		row('lesson-1', 'solution-1', 0, 'solution', { slug: 'sol-1' }),
	]

	it('nests three levels and keeps sibling order', () => {
		const tree = buildNavigationTree(groupNavigationRows(rows), 'workshop-1', 3)

		expect(tree.map((wrapper) => wrapper.resource.id)).toEqual([
			'section-1',
			'section-2',
		])
		const lessons = tree[0].resource.resources
		expect(lessons.map((wrapper: any) => wrapper.resource.id)).toEqual([
			'lesson-1',
			'lesson-2',
		])
		expect(
			lessons[0].resource.resources.map((w: any) => w.resource.id),
		).toEqual(['solution-1'])
	})

	it('leaves no resources key on the leaf level, like the old query shape', () => {
		const tree = buildNavigationTree(groupNavigationRows(rows), 'workshop-1', 3)
		const solution = tree[0].resource.resources[0].resource.resources[0]
		expect('resources' in solution.resource).toBe(false)
	})

	it('keeps the wrapper row columns beside the nested resource', () => {
		const tree = buildNavigationTree(groupNavigationRows(rows), 'workshop-1', 3)
		expect(tree[1]).toMatchObject({
			resourceOfId: 'workshop-1',
			resourceId: 'section-2',
			position: 1,
		})
		// A childless section still presents an (empty) child list, same as the
		// relational query's json_array() fallback.
		expect(tree[1].resource.resources).toEqual([])
	})
})
