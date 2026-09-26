import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncPlan } from './types'
import { AI_HERO_COURSE_SYNC_BINDING_COHORT_005 } from './types'
import { syntheticCohortBinding } from './test-fixtures/cohort-binding'

const mocks = vi.hoisted(() => {
	const receipts = new Map<string, string>()
	return {
		select: vi.fn(),
		trigger: vi.fn(
			async (
				_cohort: string,
				_changes: unknown,
				_id?: string,
				_context?: unknown,
			) => undefined,
		),
		claim: vi.fn(async (input: { kind: string }) => {
			if (receipts.has(input.kind) && receipts.get(input.kind) !== 'failed')
				return false
			receipts.set(input.kind, 'started')
			return true
		}),
		complete: vi.fn(async (input: { kind: string }) => {
			receipts.set(input.kind, 'succeeded')
		}),
		fail: vi.fn(async (input: { kind: string }) => {
			receipts.set(input.kind, 'failed')
		}),
		receipts,
		error: vi.fn(async () => undefined),
	}
})
let storedRun: {
	bindingId: string
	state: string
	plan: SyncPlan
	runId: string
	courseVersionId: string
	sourceRevisionId: string
	planSha256: string
}
vi.mock('@/db', () => ({
	db: { select: (...args: unknown[]) => mocks.select(...args) },
}))
vi.mock('@/lib/cohort-update-trigger', () => ({
	triggerCohortEntitlementSync: mocks.trigger,
}))
vi.mock('@/server/logger', () => ({ log: { error: mocks.error } }))
vi.mock('./detection-persistence', () => ({
	claimCourseSyncReviewNotification: mocks.claim,
	completeCourseSyncReviewNotification: mocks.complete,
	failCourseSyncReviewNotification: mocks.fail,
}))
vi.mock('./types', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./types')>()
	return {
		...actual,
		getServerCourseSyncBinding: (id: string) =>
			id === syntheticCohortBinding.bindingId
				? syntheticCohortBinding
				: actual.getServerCourseSyncBinding(id),
	}
})

import {
	cohortWorkshopEntitlementChanges,
	deliverCourseSyncEntitlementSync,
} from './cohort-entitlements'

const workshop = (
	id: string,
	opts: {
		action?: 'create' | 'update'
		detached?: boolean
		previousDetached?: boolean
		position?: number
		previousPosition?: number
	} = {},
) => ({
	sourceKind: 'workshop' as const,
	sourceId: id,
	targetResourceId: id,
	parentResourceId: syntheticCohortBinding.anchorCohortId,
	position: opts.position ?? 0,
	previousPosition: opts.previousPosition ?? null,
	detached: opts.detached ?? false,
	previousDetached: opts.previousDetached ?? false,
	action: opts.action ?? 'create',
	previousParentResourceId: null,
	previousVersionId: null,
	previousFieldsSha256: null,
	fields: {},
})
const plan = (resources: SyncPlan['resources']): SyncPlan => ({
	bindingId: syntheticCohortBinding.bindingId,
	sourceRevisionId: 'revision',
	courseVersionId: 'version',
	resources,
	media: [],
	planSha256: 'plan-hash',
})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.receipts.clear()
	mocks.trigger.mockResolvedValue(undefined)
	storedRun = {
		bindingId: syntheticCohortBinding.bindingId,
		state: 'applied',
		plan: plan([workshop('new-workshop', { position: 2 })]),
		runId: 'run-1',
		courseVersionId: 'version',
		sourceRevisionId: 'revision',
		planSha256: 'plan-hash',
	}
	mocks.select.mockImplementation(() => {
		const row =
			mocks.select.mock.calls.length % 2 === 1
				? storedRun
				: { providerRevision: 'dropbox-r1' }
		return { from: () => ({ where: () => ({ limit: async () => [row] }) }) }
	})
})

describe('cohort course-sync entitlements', () => {
	it('classifies created, detached and re-attached workshops, reversing them on rollback', () => {
		const resources = [
			workshop('new', { position: 2 }),
			workshop('detached', {
				action: 'update',
				detached: true,
				previousPosition: 3,
			}),
			workshop('restored', {
				action: 'update',
				previousDetached: true,
				position: 4,
			}),
		]
		expect(
			cohortWorkshopEntitlementChanges(plan(resources), 'applied'),
		).toEqual({
			resourcesAdded: [
				{ resourceId: 'new', position: 2 },
				{ resourceId: 'restored', position: 4 },
			],
			resourcesRemoved: [{ resourceId: 'detached' }],
		})
		expect(
			cohortWorkshopEntitlementChanges(plan(resources), 'rolled_back'),
		).toEqual({
			resourcesAdded: [{ resourceId: 'detached', position: 3 }],
			resourcesRemoved: [{ resourceId: 'new' }, { resourceId: 'restored' }],
		})
	})

	it('triggers once per lifecycle with a stable ID; rollback restores a detached workshop', async () => {
		storedRun.plan = plan([
			workshop('detached', {
				action: 'update',
				detached: true,
				previousPosition: 3,
			}),
		])
		await expect(
			deliverCourseSyncEntitlementSync({
				controlPlaneRunId: 'run-1',
				lifecycle: 'applied',
			}),
		).resolves.toEqual({ triggered: true })
		expect(mocks.trigger).toHaveBeenCalledWith(
			'test-cohort',
			{
				resourcesAdded: [],
				resourcesRemoved: [{ resourceId: 'detached' }],
				boundedRemovals: ['detached'],
			},
			expect.stringMatching(/^course-sync-entitlement-/),
			{ source: 'course-sync', controlPlaneRunId: 'run-1' },
		)
		await expect(
			deliverCourseSyncEntitlementSync({
				controlPlaneRunId: 'run-1',
				lifecycle: 'applied',
			}),
		).resolves.toEqual({ triggered: false, reason: 'already-claimed' })
		storedRun.state = 'rolled_back'
		await expect(
			deliverCourseSyncEntitlementSync({
				controlPlaneRunId: 'run-1',
				lifecycle: 'rolled_back',
			}),
		).resolves.toEqual({ triggered: true })
		expect(mocks.trigger).toHaveBeenLastCalledWith(
			'test-cohort',
			{
				resourcesAdded: [{ resourceId: 'detached', position: 3 }],
				resourcesRemoved: [],
				boundedRemovals: [],
			},
			expect.stringMatching(/^course-sync-entitlement-/),
			{ source: 'course-sync', controlPlaneRunId: 'run-1' },
		)
		expect(mocks.trigger).toHaveBeenCalledTimes(2)
	})

	it('bounds a create-only apply to zero removals even when the cohort read is stale', async () => {
		await deliverCourseSyncEntitlementSync({
			controlPlaneRunId: 'run-1',
			lifecycle: 'applied',
		})
		expect(mocks.trigger).toHaveBeenCalledWith(
			'test-cohort',
			expect.objectContaining({
				resourcesAdded: [{ resourceId: 'new-workshop', position: 2 }],
				boundedRemovals: [],
			}),
			expect.any(String),
			{ source: 'course-sync', controlPlaneRunId: 'run-1' },
		)
	})

	it('delivers a production Cohort 005 create-only plan with no authorized removals', async () => {
		const cohort = AI_HERO_COURSE_SYNC_BINDING_COHORT_005
		storedRun.bindingId = cohort.bindingId
		storedRun.plan = {
			...plan(
				Array.from({ length: 15 }, (_, position) => ({
					...workshop(`new-workshop-${position}`, { position }),
					parentResourceId: cohort.anchorCohortId,
				})),
			),
			bindingId: cohort.bindingId,
		}
		await expect(
			deliverCourseSyncEntitlementSync({
				controlPlaneRunId: 'run-1',
				lifecycle: 'applied',
			}),
		).resolves.toEqual({ triggered: true })
		expect(mocks.trigger).toHaveBeenCalledWith(
			cohort.anchorCohortId,
			{
				resourcesAdded: Array.from({ length: 15 }, (_, position) => ({
					resourceId: `new-workshop-${position}`,
					position,
				})),
				resourcesRemoved: [],
				boundedRemovals: [],
			},
			expect.any(String),
			{ source: 'course-sync', controlPlaneRunId: 'run-1' },
		)
	})

	it('records a failed trigger without failing applied state and can retry the same ID', async () => {
		mocks.trigger.mockRejectedValueOnce(new Error('Inngest unavailable'))
		await expect(
			deliverCourseSyncEntitlementSync({
				controlPlaneRunId: 'run-1',
				lifecycle: 'applied',
			}),
		).resolves.toEqual({ triggered: false, reason: 'failed' })
		expect(storedRun.state).toBe('applied')
		expect(mocks.fail).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'entitlement-applied',
				failureClass: 'COHORT_ENTITLEMENT_TRIGGER_FAILED',
			}),
		)
		expect(mocks.error).toHaveBeenCalledWith(
			'course_sync.cohort_entitlement_sync.failed',
			expect.objectContaining({ controlPlaneRunId: 'run-1' }),
		)
		await expect(
			deliverCourseSyncEntitlementSync({
				controlPlaneRunId: 'run-1',
				lifecycle: 'applied',
			}),
		).resolves.toEqual({ triggered: true })
		expect(mocks.trigger.mock.calls[0]?.[2]).toBe(
			mocks.trigger.mock.calls[1]?.[2],
		)
	})

	it('throws explicitly if the persisted run for entitlement delivery is missing', async () => {
		mocks.select.mockImplementationOnce(() => ({
			from: () => ({ where: () => ({ limit: async () => [] }) }),
		}))
		await expect(
			deliverCourseSyncEntitlementSync({
				controlPlaneRunId: 'missing-run',
				lifecycle: 'applied',
			}),
		).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
		expect(mocks.trigger).not.toHaveBeenCalled()
	})

	it('never triggers for the production v4 binding, even with workshop-looking plan items', async () => {
		storedRun.bindingId = 'csb_ai_coding_crash_course'
		await expect(
			deliverCourseSyncEntitlementSync({
				controlPlaneRunId: 'run-1',
				lifecycle: 'applied',
			}),
		).resolves.toEqual({ triggered: false, reason: 'not-cohort' })
		expect(mocks.trigger).not.toHaveBeenCalled()
	})
})
