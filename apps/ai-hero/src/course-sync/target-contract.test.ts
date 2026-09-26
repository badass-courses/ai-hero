import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createCourseSyncControlPlane } from './control-plane'
import { CourseSyncError } from './errors'
import { InMemoryCourseSyncPersistence } from './in-memory-persistence'
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
	COURSE_SYNC_BINDINGS,
	getServerCourseSyncBinding,
	activeCourseSyncBindings,
	type CohortCourseSyncBinding,
} from './types'
import {
	resolveStoredCourseSyncBinding,
	stableValue,
} from './binding-migration'

const syntheticCohortBinding = {
	contractVersion: 5,
	bindingId: 'csb_test_cohort',
	status: 'active',
	sourceCourseId: 'test-course',
	productId: 'test-product',
	anchorCohortId: 'test-cohort',
	targetContract: {
		product: { type: 'cohort', state: 'draft', visibility: 'unlisted' },
		cohort: { type: 'cohort', state: 'draft', visibility: 'unlisted' },
		relation: { position: 0, exclusiveProduct: true },
	},
	managedChildContract: {
		workshop: { state: 'draft', visibility: 'unlisted' },
		lesson: { state: 'draft', visibility: 'unlisted' },
	},
	applyPolicy: 'operator',
	initialApplyPolicyOverride: 'operator',
	sectionMappingPolicy: 'sections-as-cohort-workshops',
	sharedLinkSecretRef: 'DROPBOX_SYNC_SHARED_LINK_COHORT_005',
	assetConnector: 'dropbox-shared-link',
} as const satisfies CohortCourseSyncBinding

describe('server-owned binding registry', () => {
	it('pins the production Crash Course row serialization (T1)', () => {
		const serialized = JSON.stringify(stableValue(AI_HERO_COURSE_SYNC_BINDING))
		expect(createHash('sha256').update(serialized).digest('hex')).toBe(
			'3b596370d811f263437c0e57147f4d28175d49a8692ed5aa48e689b9ca98b397',
		)
	})

	it('registers only the Crash Course in production; test injection resolves synthetic cohort (T3)', () => {
		expect(Object.keys(COURSE_SYNC_BINDINGS)).toEqual([
			AI_HERO_COURSE_SYNC_BINDING.bindingId,
		])
		expect(activeCourseSyncBindings()).toEqual([AI_HERO_COURSE_SYNC_BINDING])
		expect(
			getServerCourseSyncBinding(AI_HERO_COURSE_SYNC_BINDING.bindingId),
		).toBe(AI_HERO_COURSE_SYNC_BINDING)
		expect(
			getServerCourseSyncBinding(syntheticCohortBinding.bindingId, {
				[syntheticCohortBinding.bindingId]: syntheticCohortBinding,
			}),
		).toBe(syntheticCohortBinding)
		expect(() => getServerCourseSyncBinding('unknown')).toThrowError(
			expect.objectContaining({ code: 'BINDING_NOT_FOUND', status: 404 }),
		)
	})

	it('rejects injected v5 before persistence writes and unknown ids with 404', async () => {
		const persistence = new InMemoryCourseSyncPersistence()
		const unavailable = async (): Promise<never> => { throw new Error('unexpected side effect') }
		const plane = createCourseSyncControlPlane({
			bindingRegistry: { [syntheticCohortBinding.bindingId]: syntheticCohortBinding },
			persistence,
			muxSourceResolver: { resolve: unavailable },
			muxClient: { getAsset: unavailable, createAsset: unavailable, waitForReady: unavailable },
			createdById: 'test-writer',
		})
		await expect(plane.ensureBinding(syntheticCohortBinding.bindingId)).rejects.toMatchObject({ code: 'BINDING_VERSION_UNSUPPORTED' })
		await expect(plane.ensureBinding('unknown')).rejects.toMatchObject({ code: 'BINDING_NOT_FOUND', status: 404 })
		expect(persistence.bindings.size).toBe(0)
	})

	it('rejects v5 target checks explicitly until S4b', () => {
		expect(() =>
			collectCourseSyncTargetViolations(syntheticCohortBinding, validFacts()),
		).toThrowError(
			expect.objectContaining({ code: 'BINDING_VERSION_UNSUPPORTED' }),
		)
	})

	it('rejects synthetic cohort drift and never migrates it through Crash Course v2/v3 (T4)', () => {
		expect(
			resolveStoredCourseSyncBinding(
				structuredClone(syntheticCohortBinding),
				syntheticCohortBinding,
			),
		).toMatchObject({ migrated: false })
		for (const stored of [
			{ ...syntheticCohortBinding, productId: 'wrong-product' },
			AI_HERO_COURSE_SYNC_BINDING_V2_OPERATOR,
			AI_HERO_COURSE_SYNC_BINDING_V3_UNLISTED,
		]) {
			expect(() =>
				resolveStoredCourseSyncBinding(stored, syntheticCohortBinding),
			).toThrowError(
				expect.objectContaining({ code: 'IMMUTABLE_BINDING_CONFLICT' }),
			)
		}
	})
})

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

	it('accepts contiguous live sections when a detached child is excluded from the reader', () => {
		const facts = validFacts()
		const rows = [
			{ position: 0, deletedAt: null, resource: facts.childRelations[0]!.resource },
			{ position: 1, deletedAt: new Date(), resource: { ...facts.childRelations[0]!.resource!, id: 'removed' } },
			{ position: 1, deletedAt: null, resource: { ...facts.childRelations[0]!.resource!, id: 'section-2' } },
		]
		facts.childRelations = rows.filter((row) => row.deletedAt === null)
			.map(({ position, resource }) => ({ position, resource }))
		expect(facts.childRelations.map((row) => row.position)).toEqual([0, 1])
		expect(collectCourseSyncTargetViolations(AI_HERO_COURSE_SYNC_BINDING, facts)).toEqual([])
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
