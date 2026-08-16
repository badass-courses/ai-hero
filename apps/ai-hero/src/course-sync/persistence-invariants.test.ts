import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { AI_HERO_COURSE_SYNC_BINDING, type CourseSyncBinding } from './types'
import {
	assertManagedChildRelations,
	chunkCourseSyncWrites,
	courseSyncRollbackPointer,
	resolveCourseSyncRollbackFields,
} from './persistence-invariants'

function section(position: number) {
	return {
		position,
		resource: {
			type: 'section',
			fields: {
				state: 'draft',
				visibility: 'unlisted',
				courseSync: { bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId },
			},
		},
	}
}

describe('course sync persistence invariants', () => {
	it('creates the exact prefixed frozen-asset receipt table without masking drift', () => {
		const migration = readFileSync(
			new URL(
				'../db/migrations/20260816_ai_hero_course_sync_launch_safety.sql',
				import.meta.url,
			),
			'utf8',
		)
		expect(migration).toMatch(
			/^CREATE TABLE `AI_CourseSyncFrozenAssetReceipt` \(/,
		)
		expect(migration).not.toMatch(/IF NOT EXISTS/i)
		expect(migration).not.toMatch(/CREATE TABLE `CourseSyncFrozenAssetReceipt`/)
	})

	it('restores previous fields into both the rollback version and denormalized pointer', () => {
		const appliedFields = {
			title: 'Applied title',
			body: 'Applied body',
			state: 'draft',
			visibility: 'unlisted',
			courseSync: { bindingId: 'binding-1', active: true },
		}
		const previousFields = {
			title: 'Previous title',
			body: 'Previous body',
			state: 'draft',
			visibility: 'unlisted',
			courseSync: { bindingId: 'binding-1', active: true },
		}
		const restoredFields = resolveCourseSyncRollbackFields({
			action: 'update',
			sourceKind: 'lesson',
			currentFields: appliedFields,
			previousVersionFields: previousFields,
			runId: 'run-1',
		})
		const pointer = courseSyncRollbackPointer({
			resourceId: 'lesson-1',
			resourceType: 'lesson',
			createdById: 'user-1',
			versionId: 'version-previous',
			fields: restoredFields,
		})

		expect(restoredFields).toEqual(previousFields)
		expect(restoredFields).not.toEqual(appliedFields)
		expect(pointer).toEqual({
			id: 'lesson-1',
			type: 'lesson',
			createdById: 'user-1',
			currentVersionId: 'version-previous',
			fields: previousFields,
		})
	})

	it('rejects an updated resource when its previous version fields are missing', () => {
		expect(() =>
			resolveCourseSyncRollbackFields({
				action: 'update',
				sourceKind: 'lesson',
				currentFields: { title: 'Applied' },
				previousVersionFields: null,
				runId: 'run-1',
			}),
		).toThrowError(
			expect.objectContaining({ code: 'ROLLBACK_PARENT_VERSION_MISSING' }),
		)
	})

	it('leaves retained fields alone and safely tombstones created resource fields', () => {
		const currentFields = {
			title: 'Current',
			state: 'ready',
			visibility: 'unlisted',
			courseSync: { bindingId: 'binding-1', active: true },
		}
		expect(
			resolveCourseSyncRollbackFields({
				action: 'retain',
				sourceKind: 'video',
				currentFields,
				previousVersionFields: null,
				runId: 'run-1',
			}),
		).toEqual(currentFields)
		expect(
			resolveCourseSyncRollbackFields({
				action: 'create',
				sourceKind: 'video',
				currentFields,
				previousVersionFields: null,
				runId: 'run-1',
			}),
		).toEqual({
			...currentFields,
			state: 'deleted',
			visibility: 'unlisted',
			courseSync: {
				bindingId: 'binding-1',
				active: false,
				rollbackOfRunId: 'run-1',
			},
		})
	})

	it('splits apply writes into bounded multi-row batches without loss or duplication', () => {
		const rows = Array.from({ length: 121 }, (_, index) => index)
		const chunks = chunkCourseSyncWrites(rows, 50)
		expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 21])
		expect(chunks.flat()).toEqual(rows)
	})

	it('accepts any number of ordered managed sections', () => {
		expect(() =>
			assertManagedChildRelations(
				AI_HERO_COURSE_SYNC_BINDING as CourseSyncBinding,
				[section(0), section(1), section(2)],
			),
		).not.toThrow()
	})

	it('rejects duplicate, negative, or foreign managed child slots', () => {
		const binding = AI_HERO_COURSE_SYNC_BINDING as CourseSyncBinding
		expect(() =>
			assertManagedChildRelations(binding, [section(0), section(0)]),
		).toThrowError(
			expect.objectContaining({ code: 'TARGET_CHILD_SCOPE_WIDENED' }),
		)
		expect(() =>
			assertManagedChildRelations(binding, [section(-1)]),
		).toThrowError(
			expect.objectContaining({ code: 'TARGET_CHILD_SCOPE_WIDENED' }),
		)
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
		).toThrowError(
			expect.objectContaining({ code: 'TARGET_CHILD_SCOPE_WIDENED' }),
		)
	})
})
