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
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005,
	AI_HERO_COURSE_SYNC_BINDING_V1,
	AI_HERO_COURSE_SYNC_BINDING_V2_OPERATOR,
	AI_HERO_COURSE_SYNC_BINDING_V3_UNLISTED,
	COURSE_SYNC_BINDINGS,
	getServerCourseSyncBinding,
	activeCourseSyncBindings,
} from './types'
import { syntheticCohortBinding } from './test-fixtures/cohort-binding'
import {
	resolveStoredCourseSyncBinding,
	stableValue,
} from './binding-migration'

describe('server-owned binding registry', () => {
	it('pins the production Crash Course row serialization (T1)', () => {
		const serialized = JSON.stringify(stableValue(AI_HERO_COURSE_SYNC_BINDING))
		expect(createHash('sha256').update(serialized).digest('hex')).toBe(
			'3b596370d811f263437c0e57147f4d28175d49a8692ed5aa48e689b9ca98b397',
		)
	})

	it('deep-freezes the production registry and the entire binding contract (P2)', () => {
		expect(Object.isFrozen(COURSE_SYNC_BINDINGS)).toBe(true)
		expect(Object.isFrozen(AI_HERO_COURSE_SYNC_BINDING)).toBe(true)
		expect(Object.isFrozen(AI_HERO_COURSE_SYNC_BINDING.targetContract)).toBe(
			true,
		)
		expect(
			Object.isFrozen(AI_HERO_COURSE_SYNC_BINDING.targetContract.product),
		).toBe(true)
		expect(
			Object.isFrozen(AI_HERO_COURSE_SYNC_BINDING.targetContract.workshop),
		).toBe(true)
		expect(
			Object.isFrozen(AI_HERO_COURSE_SYNC_BINDING.targetContract.relation),
		).toBe(true)
		expect(
			Object.isFrozen(AI_HERO_COURSE_SYNC_BINDING.managedChildContract),
		).toBe(true)
		const cohort = AI_HERO_COURSE_SYNC_BINDING_COHORT_005
		for (const contract of [
			cohort,
			cohort.targetContract,
			cohort.targetContract.product,
			cohort.targetContract.cohort,
			cohort.targetContract.relation,
			cohort.managedChildContract,
			cohort.managedChildContract.workshop,
			cohort.managedChildContract.lesson,
		]) {
			expect(Object.isFrozen(contract)).toBe(true)
		}
		expect(() =>
			Object.assign(AI_HERO_COURSE_SYNC_BINDING.targetContract.product, {
				state: 'draft',
			}),
		).toThrow(TypeError)
		expect(() =>
			Object.assign(COURSE_SYNC_BINDINGS, { extra: syntheticCohortBinding }),
		).toThrow(TypeError)
	})

	it('registers exactly two active bindings while preserving the Crash Course lookup (T3)', () => {
		expect(Object.keys(COURSE_SYNC_BINDINGS)).toEqual([
			AI_HERO_COURSE_SYNC_BINDING.bindingId,
			AI_HERO_COURSE_SYNC_BINDING_COHORT_005.bindingId,
		])
		expect(activeCourseSyncBindings()).toEqual([
			AI_HERO_COURSE_SYNC_BINDING,
			AI_HERO_COURSE_SYNC_BINDING_COHORT_005,
		])
		expect(
			getServerCourseSyncBinding(AI_HERO_COURSE_SYNC_BINDING.bindingId),
		).toBe(AI_HERO_COURSE_SYNC_BINDING)
		expect(getServerCourseSyncBinding('csb_ai_hero_cohort_005')).toBe(
			AI_HERO_COURSE_SYNC_BINDING_COHORT_005,
		)
		expect(
			getServerCourseSyncBinding(syntheticCohortBinding.bindingId, {
				[syntheticCohortBinding.bindingId]: syntheticCohortBinding,
			}),
		).toBe(syntheticCohortBinding)
		expect(() => getServerCourseSyncBinding('unknown')).toThrowError(
			expect.objectContaining({ code: 'BINDING_NOT_FOUND', status: 404 }),
		)
	})

	it('pins the production Cohort 005 contract to the S0 readback and S5 spec (T21)', () => {
		expect(AI_HERO_COURSE_SYNC_BINDING_COHORT_005).toEqual({
			contractVersion: 5,
			bindingId: 'csb_ai_hero_cohort_005',
			status: 'active',
			sourceCourseId: '4cc62b33-db58-455d-83cb-94f680b119e4',
			productId: 'product-s00zs',
			anchorCohortId: 'cohort-xdy1m',
			targetContract: {
				product: { type: 'cohort', state: 'draft', visibility: 'unlisted' },
				cohort: { type: 'cohort', state: 'draft', visibility: 'unlisted' },
				relation: { position: 0, exclusiveProduct: true },
			},
			managedChildContract: {
				workshop: { state: 'draft', visibility: 'unlisted' },
				lesson: { state: 'draft', visibility: 'unlisted' },
			},
			applyPolicy: 'bounded-auto',
			initialApplyPolicyOverride: 'operator',
			sectionMappingPolicy: 'sections-as-cohort-workshops',
			sharedLinkSecretRef: 'DROPBOX_SYNC_SHARED_LINK_COHORT_005',
			assetConnector: 'dropbox-shared-link',
		})
	})

	it('allows injected v5 through binding lookup while unknown ids still return 404', async () => {
		const persistence = new InMemoryCourseSyncPersistence()
		const unavailable = async (): Promise<never> => {
			throw new Error('unexpected side effect')
		}
		const plane = createCourseSyncControlPlane({
			bindingRegistry: {
				[syntheticCohortBinding.bindingId]: syntheticCohortBinding,
			},
			persistence,
			muxSourceResolver: { resolve: unavailable },
			muxClient: {
				getAsset: unavailable,
				createAsset: unavailable,
				waitForReady: unavailable,
			},
			createdById: 'test-writer',
		})
		await expect(
			plane.ensureBinding(syntheticCohortBinding.bindingId),
		).resolves.toMatchObject({
			contractVersion: 5,
			target: {
				cohort: { type: 'cohort' },
				sectionMappingPolicy: 'sections-as-cohort-workshops',
			},
		})
		await expect(
			plane.getBinding(syntheticCohortBinding.bindingId),
		).resolves.toMatchObject({ contractVersion: 5 })
		await expect(plane.ensureBinding('unknown')).rejects.toMatchObject({
			code: 'BINDING_NOT_FOUND',
			status: 404,
		})
		expect(persistence.bindings.size).toBe(1)
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

function validCohortFacts(): CourseSyncTargetFacts {
	return {
		product: {
			id: 'test-product',
			type: 'cohort',
			fields: { state: 'draft', visibility: 'unlisted' },
		},
		workshop: {
			id: 'test-cohort',
			type: 'cohort',
			fields: { state: 'draft', visibility: 'unlisted' },
			deletedAt: null,
		},
		relation: { position: 0 },
		otherProductRelations: [],
		childRelations: [],
	}
}

describe('cohort-anchored target contract v5', () => {
	it('accepts the synthetic draft/unlisted cohort with zero live children (T5)', () => {
		expect(
			collectCourseSyncTargetViolations(
				syntheticCohortBinding,
				validCohortFacts(),
			),
		).toEqual([])
	})

	it('reports product, anchor, relation and workshop child violations with existing codes (T6)', () => {
		const facts = validCohortFacts()
		facts.product = {
			id: 'test-product',
			type: 'workshop',
			fields: { state: 'published', visibility: 'public' },
		}
		facts.workshop = {
			id: 'test-cohort',
			type: 'workshop',
			fields: { state: 'published', visibility: 'public' },
			deletedAt: null,
		}
		facts.relation = { position: 2 }
		facts.childRelations = [
			{
				position: 0,
				resource: {
					id: 'foreign-child',
					type: 'section',
					fields: {
						state: 'published',
						visibility: 'public',
						courseSync: { bindingId: 'other' },
					},
				},
			},
		]
		expect(
			collectCourseSyncTargetViolations(syntheticCohortBinding, facts).map(
				(v) => v.code,
			),
		).toEqual([
			'TARGET_PRODUCT_TYPE_MISMATCH',
			'TARGET_PRODUCT_STATE_MISMATCH',
			'TARGET_PRODUCT_VISIBILITY_MISMATCH',
			'TARGET_WORKSHOP_TYPE_MISMATCH',
			'TARGET_WORKSHOP_STATE_MISMATCH',
			'TARGET_WORKSHOP_VISIBILITY_MISMATCH',
			'TARGET_RELATION_POSITION_MISMATCH',
			'TARGET_CHILD_TYPE_MISMATCH',
			'TARGET_CHILD_STATE_MISMATCH',
			'TARGET_CHILD_VISIBILITY_MISMATCH',
			'TARGET_CHILD_BINDING_MISMATCH',
		])
	})

	it('reports missing cohort target rows and a missing relation with the existing codes', () => {
		const facts = validCohortFacts()
		facts.product = null
		facts.workshop = null
		facts.relation = null
		expect(
			collectCourseSyncTargetViolations(syntheticCohortBinding, facts).map(
				(v) => v.code,
			),
		).toEqual([
			'TARGET_PRODUCT_NOT_FOUND',
			'TARGET_WORKSHOP_NOT_FOUND',
			'TARGET_RELATION_MISSING',
		])
	})

	it('accepts contiguous live workshop children after detached relations are excluded by the reader (T7)', () => {
		const facts = validCohortFacts()
		facts.childRelations = [0, 1].map((position) => ({
			position,
			resource: {
				id: `test-workshop-${position}`,
				type: 'workshop',
				fields: {
					state: 'draft',
					visibility: 'unlisted',
					courseSync: { bindingId: syntheticCohortBinding.bindingId },
				},
			},
		}))
		expect(
			collectCourseSyncTargetViolations(syntheticCohortBinding, facts),
		).toEqual([])
	})
})

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
			{
				position: 0,
				deletedAt: null,
				resource: facts.childRelations[0]!.resource,
			},
			{
				position: 1,
				deletedAt: new Date(),
				resource: { ...facts.childRelations[0]!.resource!, id: 'removed' },
			},
			{
				position: 1,
				deletedAt: null,
				resource: { ...facts.childRelations[0]!.resource!, id: 'section-2' },
			},
		]
		facts.childRelations = rows
			.filter((row) => row.deletedAt === null)
			.map(({ position, resource }) => ({ position, resource }))
		expect(facts.childRelations.map((row) => row.position)).toEqual([0, 1])
		expect(
			collectCourseSyncTargetViolations(AI_HERO_COURSE_SYNC_BINDING, facts),
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
