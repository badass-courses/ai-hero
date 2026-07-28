import { describe, expect, it } from 'vitest'

import {
	AI_HERO_DRAFT_SYNC_BINDING,
	type CourseSyncBinding,
} from './types'
import {
	assertManagedChildRelations,
	chunkCourseSyncWrites,
} from './persistence-invariants'

function section(position: number) {
	return {
		position,
		resource: {
			type: 'section',
			fields: {
				state: 'draft',
				visibility: 'unlisted',
				courseSync: { bindingId: AI_HERO_DRAFT_SYNC_BINDING.bindingId },
			},
		},
	}
}

describe('course sync persistence invariants', () => {
	it('splits apply writes into bounded multi-row batches without loss or duplication', () => {
		const rows = Array.from({ length: 121 }, (_, index) => index)
		const chunks = chunkCourseSyncWrites(rows, 50)
		expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 21])
		expect(chunks.flat()).toEqual(rows)
	})

	it('accepts any number of ordered managed sections', () => {
		expect(() =>
			assertManagedChildRelations(
				AI_HERO_DRAFT_SYNC_BINDING as CourseSyncBinding,
				[section(0), section(1), section(2)],
			),
		).not.toThrow()
	})

	it('rejects duplicate, negative, or foreign managed child slots', () => {
		const binding = AI_HERO_DRAFT_SYNC_BINDING as CourseSyncBinding
		expect(() =>
			assertManagedChildRelations(binding, [section(0), section(0)]),
		).toThrowError(expect.objectContaining({ code: 'TARGET_CHILD_SCOPE_WIDENED' }))
		expect(() =>
			assertManagedChildRelations(binding, [section(-1)]),
		).toThrowError(expect.objectContaining({ code: 'TARGET_CHILD_SCOPE_WIDENED' }))
		expect(() =>
			assertManagedChildRelations(binding, [
				{
					...section(3),
					resource: {
						type: 'section',
						fields: {
							state: 'draft',
							visibility: 'unlisted',
							courseSync: { bindingId: 'another-binding' },
						},
					},
				},
			]),
		).toThrowError(expect.objectContaining({ code: 'TARGET_CHILD_SCOPE_WIDENED' }))
	})
})
