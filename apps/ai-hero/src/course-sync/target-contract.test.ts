import { describe, expect, it } from 'vitest'

import { CourseSyncError } from './errors'
import {
	assertCourseSyncTargetContract,
	collectCourseSyncTargetViolations,
	type CourseSyncTargetFacts,
} from './target-contract'
import {
	AI_HERO_COURSE_SYNC_BINDING,
	AI_HERO_COURSE_SYNC_BINDING_V1,
	AI_HERO_COURSE_SYNC_BINDING_V2_OPERATOR,
	AI_HERO_COURSE_SYNC_BINDING_V3_UNLISTED,
} from './types'
import { resolveStoredCourseSyncBinding } from './binding-migration'

function validFacts(): CourseSyncTargetFacts {
	return {
		product: {
			id: AI_HERO_COURSE_SYNC_BINDING.productId,
			type: 'self-paced',
			fields: { state: 'published', visibility: 'public' },
		},
		workshop: {
			id: AI_HERO_COURSE_SYNC_BINDING.anchorWorkshopId,
			type: 'workshop',
			fields: { state: 'published', visibility: 'public' },
			deletedAt: null,
		},
		relation: { position: 0 },
		otherProductRelations: [],
		childRelations: [
			{
				position: 0,
				resource: {
					id: 'section-1',
					type: 'section',
					fields: {
						state: 'draft',
						visibility: 'unlisted',
						courseSync: {
							bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
						},
					},
				},
			},
		],
	}
}

describe('course sync target contract v4', () => {
	it('accepts the pinned live target while keeping managed children draft/unlisted', () => {
		expect(
			collectCourseSyncTargetViolations(
				AI_HERO_COURSE_SYNC_BINDING,
				validFacts(),
			),
		).toEqual([])
	})

	it('reports every expected and actual violation in one typed failure', () => {
		const facts = validFacts()
		facts.product!.fields = { state: 'draft', visibility: 'unlisted' }
		facts.workshop!.fields = { state: 'draft', visibility: 'unlisted' }
		facts.relation = { position: 4 }

		let failure: CourseSyncError | null = null
		try {
			assertCourseSyncTargetContract(AI_HERO_COURSE_SYNC_BINDING, facts)
		} catch (error) {
			failure = error as CourseSyncError
		}

		expect(failure).toMatchObject({
			code: 'TARGET_CONTRACT_MISMATCH',
			name: 'TARGET_CONTRACT_MISMATCH',
			retryable: false,
			category: 'target_precondition',
		})
		expect(failure?.details).toMatchObject({
			violations: [
				{
					code: 'TARGET_PRODUCT_STATE_MISMATCH',
					expected: 'published',
					actual: 'draft',
				},
				{
					code: 'TARGET_PRODUCT_VISIBILITY_MISMATCH',
					expected: 'public',
					actual: 'unlisted',
				},
				{
					code: 'TARGET_WORKSHOP_STATE_MISMATCH',
					expected: 'published',
					actual: 'draft',
				},
				{
					code: 'TARGET_WORKSHOP_VISIBILITY_MISMATCH',
					expected: 'public',
					actual: 'unlisted',
				},
				{
					code: 'TARGET_RELATION_POSITION_MISMATCH',
					expected: 0,
					actual: 4,
				},
			],
		})
	})

	it('reports managed-child drift without applying the live target contract to children', () => {
		const facts = validFacts()
		facts.childRelations[0]!.resource!.fields = {
			state: 'published',
			visibility: 'public',
			courseSync: { bindingId: 'foreign-binding' },
		}
		const violations = collectCourseSyncTargetViolations(
			AI_HERO_COURSE_SYNC_BINDING,
			facts,
		)
		expect(violations.map((item) => item.code)).toEqual([
			'TARGET_CHILD_STATE_MISMATCH',
			'TARGET_CHILD_VISIBILITY_MISMATCH',
			'TARGET_CHILD_BINDING_MISMATCH',
		])
		expect(violations[0]).toMatchObject({
			expected: 'draft',
			actual: 'published',
		})
	})
})

describe('stored binding migration', () => {
	it('migrates only the exact v2/v3 literals and is idempotent on v4', () => {
		expect(() =>
			resolveStoredCourseSyncBinding(
				structuredClone(AI_HERO_COURSE_SYNC_BINDING_V1),
				AI_HERO_COURSE_SYNC_BINDING,
			),
		).toThrowError(
			expect.objectContaining({ code: 'IMMUTABLE_BINDING_CONFLICT' }),
		)
		expect(
			resolveStoredCourseSyncBinding(
				structuredClone(AI_HERO_COURSE_SYNC_BINDING_V2_OPERATOR),
				AI_HERO_COURSE_SYNC_BINDING,
			),
		).toEqual({
			binding: AI_HERO_COURSE_SYNC_BINDING,
			migrated: true,
			fromContractVersion: 2,
		})
		expect(
			resolveStoredCourseSyncBinding(
				structuredClone(AI_HERO_COURSE_SYNC_BINDING_V3_UNLISTED),
				AI_HERO_COURSE_SYNC_BINDING,
			),
		).toEqual({
			binding: AI_HERO_COURSE_SYNC_BINDING,
			migrated: true,
			fromContractVersion: 3,
		})
		expect(
			resolveStoredCourseSyncBinding(
				structuredClone(AI_HERO_COURSE_SYNC_BINDING),
				AI_HERO_COURSE_SYNC_BINDING,
			),
		).toEqual({
			binding: AI_HERO_COURSE_SYNC_BINDING,
			migrated: false,
			fromContractVersion: null,
		})
	})

	it('rejects unknown binding drift', () => {
		expect(() =>
			resolveStoredCourseSyncBinding(
				{ ...AI_HERO_COURSE_SYNC_BINDING_V1, productId: 'unknown-product' },
				AI_HERO_COURSE_SYNC_BINDING,
			),
		).toThrowError(
			expect.objectContaining({ code: 'IMMUTABLE_BINDING_CONFLICT' }),
		)
	})
})
