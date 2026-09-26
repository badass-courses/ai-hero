import type { CourseJsonDocumentV3 } from '@ai-hero/course-sync-schema'
import { describe, expect, it, vi } from 'vitest'

import { createCourseSyncControlPlane } from './control-plane'
import {
	createCourseSyncDetectionPoller,
	type CourseSyncNotification,
	type CourseSyncPollLogInput,
	type CourseSyncPollState,
} from './detection-poller'
import { InMemoryCourseSyncPersistence } from './in-memory-persistence'
import { assertCourseSyncTargetContract } from './target-contract'
import { AI_HERO_COURSE_SYNC_BINDING_COHORT_005 as binding } from './types'

function syntheticCopyOfSyllabusShape(): CourseJsonDocumentV3 {
	// Synthetic IDs/titles, only the verified 15-section/112-placeholder shape.
	return {
		$schema: 'course.schema.json',
		schemaVersion: 4,
		courseId: binding.sourceCourseId,
		courseVersionId: 'synthetic-s5-revision',
		archiveTTL: '90d',
		courseName: 'Synthetic First Tick',
		sections: Array.from({ length: 15 }, (_, index) => ({
			id: `synthetic-section-${index}`,
			title: `Synthetic Section ${index}`,
			lessons: Array.from({ length: index < 7 ? 8 : 7 }, (_, lessonIndex) => ({
				type: 'placeholder' as const,
				id: `synthetic-lesson-${index}-${lessonIndex}`,
				title: `Synthetic Placeholder ${index}.${lessonIndex}`,
			})),
		})),
	}
}

describe('production Cohort 005 first scheduled poll (S5)', () => {
	it('stages and previews 15 workshops and 112 lessons, then waits for the operator without media or strikes', async () => {
		const manifest = syntheticCopyOfSyllabusShape()
		const persistence = new InMemoryCourseSyncPersistence()
		const unexpected = vi.fn(async (): Promise<never> => {
			throw new Error('first syllabus tick must not read or freeze media')
		})
		persistence.assertTarget = async (actualBinding) => {
			assertCourseSyncTargetContract(actualBinding, {
				product: {
					id: binding.productId,
					type: 'cohort',
					fields: { state: 'draft', visibility: 'unlisted' },
				},
				workshop: {
					id: binding.anchorCohortId,
					type: 'cohort',
					fields: { state: 'draft', visibility: 'unlisted' },
					deletedAt: null,
				},
				relation: { position: 0 },
				otherProductRelations: [],
				childRelations: [],
			})
		}
		let sequence = 0
		const plane = createCourseSyncControlPlane({
			persistence,
			muxSourceResolver: { resolve: unexpected },
			muxClient: {
				getAsset: unexpected,
				createAsset: unexpected,
				waitForReady: unexpected,
			},
			createdById: 'synthetic-writer',
			makeId: (prefix) => `${prefix}_${++sequence}`,
			clock: () => new Date('2026-09-26T04:30:00.000Z'),
		})
		let state: CourseSyncPollState | null = null
		const logs: CourseSyncPollLogInput[] = []
		const notices: CourseSyncNotification[] = []
		const apply = vi.fn(unexpected)
		const freezeAssetBatch = vi.fn(unexpected)
		const poll = createCourseSyncDetectionPoller({
			binding,
			readManifest: async () => ({
				manifest,
				summary: {
					courseVersionId: manifest.courseVersionId,
					manifest: { rev: 'synthetic-dropbox-rev', sha256: 'b'.repeat(64) },
				},
			}),
			getRevisionHead: async () => null,
			getRun: plane.getRun,
			getPollState: async () => state,
			ensureBinding: async (id) => {
				await plane.ensureBinding(id)
			},
			savePollState: async (next) => {
				state = next
			},
			appendLog: async (entry) => {
				logs.push(entry)
			},
			freezeAssetBatch,
			stage: (input) => plane.stageFrozen(input),
			preview: plane.preview,
			evaluateBoundedAutoApply: plane.evaluateBoundedAutoApply,
			claimReviewNotification: async () => true,
			completeReviewNotification: async () => {},
			failReviewNotification: async () => {},
			apply,
			verifyApplied: unexpected,
			notify: async (notice) => {
				notices.push(notice)
			},
			clock: () => new Date('2026-09-26T04:30:00.000Z'),
		})

		const result = await poll('synthetic-first-tick')
		expect(result).toMatchObject({
			outcome: 'awaiting-apply',
			courseVersionId: 'synthetic-s5-revision',
		})
		expect(state).toMatchObject({
			bindingId: binding.bindingId,
			status: 'awaiting-apply',
			applyPolicyOverride: 'operator',
			consecutiveFailures: 0,
			failureClass: null,
		})
		expect(persistence.bindings.size).toBe(1)
		const plan = persistence.runs.get(result.controlPlaneRunId!)?.plan
		expect(
			plan?.resources.filter(
				(item) => item.sourceKind === 'workshop' && item.action === 'create',
			),
		).toHaveLength(15)
		expect(
			plan?.resources.filter(
				(item) => item.sourceKind === 'lesson' && item.action === 'create',
			),
		).toHaveLength(112)
		expect(plan?.resources).toHaveLength(127)
		expect(plan?.media).toEqual([])
		expect(notices).toEqual([
			expect.objectContaining({
				kind: 'review',
				resourceCounts: { create: 127, update: 0, retain: 0 },
			}),
		])
		expect(logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: 'detect', outcome: 'succeeded' }),
				expect.objectContaining({ stage: 'stage', outcome: 'succeeded' }),
				expect.objectContaining({ stage: 'verify', outcome: 'succeeded' }),
			]),
		)
		expect(unexpected).not.toHaveBeenCalled()
		expect(freezeAssetBatch).not.toHaveBeenCalled()
		expect(apply).not.toHaveBeenCalled()
	})
})
