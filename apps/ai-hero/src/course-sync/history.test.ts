import { describe, expect, it, vi } from 'vitest'

import {
	courseSyncPollLogHistoryProjection,
	courseSyncRevisionHistoryProjection,
	courseSyncRunHistoryProjection,
	getCourseSyncHistory,
	listCourseSyncHistory,
	type CourseSyncHistorySource,
} from './history'

function source(): CourseSyncHistorySource {
	return {
		listRevisions: vi.fn(async () => [
			{
				sourceRevisionId: 'revision-070',
				bindingId: 'binding-1',
				courseVersionId: 'version-070',
				providerRevision: 'dropbox-070',
				manifestSha256: 'a'.repeat(64),
				courseName: 'AI Coding Crash Course',
				sectionCount: 4,
				lessonCount: 39,
				stagedAt: new Date('2026-07-24T18:20:00.000Z'),
			},
		]),
		listAssetSummaries: vi.fn(async () => [
			{
				sourceRevisionId: 'revision-070',
				videoCount: 47,
				muxReadyCount: 47,
			},
		]),
		listRuns: vi.fn(async () => [
			{
				runId: 'sync-run-070',
				bindingId: 'binding-1',
				sourceRevisionId: 'revision-070',
				courseVersionId: 'version-070',
				state: 'applied',
				failureCode: null,
				failureReason: null,
				createdAt: new Date('2026-07-24T18:20:00.000Z'),
				updatedAt: new Date('2026-07-24T18:51:00.000Z'),
			},
		]),
		listPollLogs: vi.fn(async () => [
			{
				id: 'log-killed-1',
				bindingId: 'binding-1',
				courseVersionId: 'version-070',
				providerRevision: 'dropbox-070',
				runId: 'poll-killed-1',
				controlPlaneRunId: null,
				stage: 'stage',
				outcome: 'failed',
				failureClass: 'POLL_RUN_KILLED',
				occurredAt: new Date('2026-07-24T18:01:00.000Z'),
			},
			{
				id: 'log-killed-2',
				bindingId: 'binding-1',
				courseVersionId: 'version-070',
				providerRevision: 'dropbox-070',
				runId: 'poll-killed-2',
				controlPlaneRunId: null,
				stage: 'stage',
				outcome: 'failed',
				failureClass: 'POLL_RUN_KILLED',
				occurredAt: new Date('2026-07-24T18:02:00.000Z'),
			},
			{
				id: 'log-hold',
				bindingId: 'binding-1',
				courseVersionId: 'version-070',
				providerRevision: 'dropbox-070',
				runId: 'poll-killed-2',
				controlPlaneRunId: null,
				stage: 'hold',
				outcome: 'held',
				failureClass: 'POLL_RUN_KILLED',
				metadata: {
					failureSummary: {
						code: 'POLL_RUN_KILLED',
						actual: ['Polling run stopped.'],
						expected: ['Polling run completes.'],
						retryable: true,
						sideEffects: {
							sourceAssetsRead: 'unknown',
							targetWrites: 'none',
						},
						currentRunCreated: false,
						previousAppliedRunId: null,
					},
				},
				occurredAt: new Date('2026-07-24T18:02:01.000Z'),
			},
			{
				id: 'log-detect',
				bindingId: 'binding-1',
				courseVersionId: 'version-070',
				providerRevision: 'dropbox-070',
				runId: 'poll-applied',
				controlPlaneRunId: 'sync-run-070',
				stage: 'detect',
				outcome: 'succeeded',
				failureClass: null,
				occurredAt: new Date('2026-07-24T18:20:00.000Z'),
			},
			{
				id: 'log-apply',
				bindingId: 'binding-1',
				courseVersionId: 'version-070',
				providerRevision: 'dropbox-070',
				runId: 'poll-applied',
				controlPlaneRunId: 'sync-run-070',
				stage: 'apply',
				outcome: 'succeeded',
				failureClass: null,
				occurredAt: new Date('2026-07-24T18:51:00.000Z'),
			},
			{
				id: 'log-idle-detect',
				bindingId: 'binding-1',
				courseVersionId: 'version-070',
				providerRevision: 'dropbox-070',
				runId: 'poll-idle-1',
				controlPlaneRunId: 'sync-run-070',
				stage: 'detect',
				outcome: 'succeeded',
				failureClass: null,
				occurredAt: new Date('2026-07-24T19:20:00.000Z'),
			},
			{
				id: 'log-idle-compare',
				bindingId: 'binding-1',
				courseVersionId: 'version-070',
				providerRevision: 'dropbox-070',
				runId: 'poll-idle-1',
				controlPlaneRunId: 'sync-run-070',
				stage: 'compare',
				outcome: 'skipped',
				failureClass: null,
				occurredAt: new Date('2026-07-24T19:20:05.000Z'),
			},
			{
				id: 'log-idle-notify',
				bindingId: 'binding-1',
				courseVersionId: 'version-070',
				providerRevision: 'dropbox-070',
				runId: 'poll-idle-1',
				controlPlaneRunId: 'sync-run-070',
				stage: 'notify',
				outcome: 'skipped',
				failureClass: null,
				occurredAt: new Date('2026-07-24T19:20:06.000Z'),
			},
		]),
		listPollStates: vi.fn(async () => [
			{
				bindingId: 'binding-1',
				courseVersionId: 'version-070',
				providerRevision: 'dropbox-070',
				status: 'succeeded',
				consecutiveFailures: 0,
				controlPlaneRunId: 'sync-run-070',
				failureClass: null,
				updatedAt: new Date('2026-07-24T18:51:00.000Z'),
			},
		]),
		listBindings: vi.fn(async () => [
			{
				bindingId: 'binding-1',
				sourceCourseId: 'source-course-1',
				productId: 'product-1',
				anchorWorkshopId: 'workshop-1',
				status: 'active',
			},
		]),
	}
}

describe('course sync history loaders', () => {
	it('keeps large manifests/plans out while selecting bounded poll metadata', () => {
		expect(Object.keys(courseSyncRevisionHistoryProjection)).not.toContain(
			'manifest',
		)
		expect(Object.keys(courseSyncRunHistoryProjection)).not.toContain('plan')
		expect(Object.keys(courseSyncPollLogHistoryProjection)).toContain(
			'metadata',
		)
	})

	it('loads the killed, held, then applied attempts as one version story', async () => {
		const historySource = source()
		const detail = await getCourseSyncHistory('version-070', historySource)

		expect(detail).toMatchObject({
			courseVersionId: 'version-070',
			courseName: 'AI Coding Crash Course',
			outcome: 'applied',
			sectionCount: 4,
			lessonCount: 39,
			videoCount: 47,
			muxReadyCount: 47,
			durationSeconds: 1860,
		})
		expect(detail?.attempts.map((attempt) => attempt.outcome)).toEqual([
			'failed',
			'held',
			'applied',
		])
		expect(detail?.attempts.map((attempt) => attempt.pollRunId)).not.toContain(
			'poll-idle-1',
		)
		expect(detail?.idlePollCount).toBe(1)
		expect(detail?.failureSummary).toBeNull()
		expect(detail?.attempts[1]?.events[1]?.failureSummary).toMatchObject({
			code: 'POLL_RUN_KILLED',
			currentRunCreated: false,
		})
		expect(historySource.listRevisions).toHaveBeenCalledWith('version-070')
		expect(historySource.listPollLogs).toHaveBeenCalledWith('version-070')
	})

	it('sorts the index newest first', async () => {
		const historySource = source()
		const older = await listCourseSyncHistory(historySource)
		expect(older.map((item) => item.courseVersionId)).toEqual(['version-070'])
		expect(historySource.listRevisions).toHaveBeenCalledWith(undefined)
	})
})
