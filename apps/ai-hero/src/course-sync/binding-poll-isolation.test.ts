import type { CourseJsonDocumentV3 } from '@ai-hero/course-sync-schema'
import { expect, it, vi } from 'vitest'

const links = vi.hoisted(() => ({
	DROPBOX_SYNC_SHARED_LINK: 'https://www.dropbox.com/crash',
	DROPBOX_SYNC_SHARED_LINK_COHORT_005: 'not-a-url' as string | undefined,
}))
vi.mock('@/env.mjs', () => ({ env: links }))

import { sharedLinkFor } from './dropbox-binding-config'
import {
	createCourseSyncDetectionPoller,
	type CourseSyncDetectionPollerDependencies,
	type CourseSyncPollState,
} from './detection-poller'
import {
	AI_HERO_COURSE_SYNC_BINDING,
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005,
	type CourseSyncBinding,
} from './types'

const unexpected = async (): Promise<never> => {
	throw new Error('Already-applied revision must not stage or freeze media')
}

function bindingPoll(binding: CourseSyncBinding) {
	let state: CourseSyncPollState | null = null
	const saved: CourseSyncPollState[] = []
	const readManifest = vi.fn(async () => {
		// The real Inngest read-course-manifest step resolves config lazily,
		// before reading Dropbox. Keep this step but skip all network traffic.
		sharedLinkFor(binding)
		const courseVersionId = `version-${binding.bindingId}`
		return {
			manifest: {
				$schema: 'course.schema.json',
				schemaVersion: 3,
				courseId: 'fixture-course',
				courseVersionId,
				courseName: 'Fixture Course',
				archiveTTL: '90d',
				sections: [],
			} as CourseJsonDocumentV3,
			summary: {
				courseVersionId,
				manifest: { rev: 'rev-1', sha256: 'a'.repeat(64) },
			},
		}
	})
	const dependencies: CourseSyncDetectionPollerDependencies = {
		binding,
		readManifest,
		getRevisionHead: async () => ({
			courseVersionId: `version-${binding.bindingId}`,
			providerRevision: 'rev-1',
			runId: 'already-applied',
			runState: 'applied',
		}),
		getRun: unexpected,
		getPollState: async () => state,
		ensureBinding: async () => undefined,
		savePollState: async (next) => {
			state = next
			saved.push(next)
		},
		appendLog: async () => undefined,
		freezeAssetBatch: unexpected,
		stage: unexpected,
		preview: unexpected,
		evaluateBoundedAutoApply: unexpected,
		claimReviewNotification: unexpected,
		completeReviewNotification: unexpected,
		failReviewNotification: unexpected,
		apply: unexpected,
		verifyApplied: unexpected,
		notify: async () => undefined,
		clock: () => new Date('2026-09-26T04:00:00.000Z'),
	}
	return {
		poll: createCourseSyncDetectionPoller(dependencies),
		readManifest,
		saved,
		state: () => state,
	}
}

it('a malformed Cohort 005 link fails only its poll state; Crash Course proceeds without a strike, then a valid link recovers', async () => {
	const crash = bindingPoll(AI_HERO_COURSE_SYNC_BINDING)
	const cohort = bindingPoll(AI_HERO_COURSE_SYNC_BINDING_COHORT_005)
	const crashResult = await crash.poll('crash-poll')
	expect(crashResult.outcome).toBe('no-op')
	expect(crash.state()).toMatchObject({
		status: 'succeeded',
		consecutiveFailures: 0,
		failureClass: null,
	})
	const cohortResult = await cohort.poll('cohort-bad-link-poll')
	expect(cohortResult).toMatchObject({
		outcome: 'failed',
		failureClass: 'SOURCE_CONFIG_INVALID',
	})
	expect(cohort.state()).toMatchObject({
		status: 'failed',
		consecutiveFailures: 1,
		failureClass: 'SOURCE_CONFIG_INVALID',
	})
	expect(crash.saved).toHaveLength(1)
	expect(crash.state()).toMatchObject({ consecutiveFailures: 0 })
	links.DROPBOX_SYNC_SHARED_LINK_COHORT_005 = 'https://www.dropbox.com/cohort'
	const recovered = await cohort.poll('cohort-valid-link-poll')
	expect(recovered.outcome).toBe('no-op')
	expect(cohort.state()).toMatchObject({
		status: 'succeeded',
		consecutiveFailures: 0,
		failureClass: null,
	})
	links.DROPBOX_SYNC_SHARED_LINK_COHORT_005 = undefined
	const missing = await cohort.poll('cohort-missing-link-poll')
	expect(missing).toMatchObject({
		outcome: 'failed',
		failureClass: 'SOURCE_CONFIG_INVALID',
	})
	expect(cohort.state()).toMatchObject({
		status: 'failed',
		failureClass: 'SOURCE_CONFIG_INVALID',
	})
	expect(crash.state()).toMatchObject({
		status: 'succeeded',
		consecutiveFailures: 0,
	})
})
