import type {
	CourseJsonDocumentV3,
	CourseSyncRunSummary,
} from '@ai-hero/course-sync-schema'
import { describe, expect, it, vi } from 'vitest'

import {
	buildCourseSyncNotificationPayload,
	createCourseSyncDetectionPoller,
	type CourseSyncDetectionPollerDependencies,
	type CourseSyncNotification,
	type CourseSyncPollLogInput,
	type CourseSyncPollState,
	type CourseSyncRevisionHead,
} from './detection-poller'

const manifest = {
	schemaVersion: 3,
	courseVersionId: 'version-2',
} as CourseJsonDocumentV3

function run(
	state: CourseSyncRunSummary['state'],
	overrides: Partial<CourseSyncRunSummary> = {},
): CourseSyncRunSummary {
	return {
		runId: 'sync-run-2',
		bindingId: 'csb_ai_coding_crash_course',
		courseVersionId: 'version-2',
		state,
		planSha256: state === 'staged' ? null : 'plan-sha',
		noOp: false,
		failureCode: state === 'failed' ? 'APPLY_FAILED' : null,
		plan:
			state === 'staged'
				? null
				: {
						resources: [
							{
								sourceKind: 'section',
								sourceId: 'section-1',
								action: 'create',
								position: 0,
							},
						],
						media: [
							{
								sourceVideoId: 'video-1',
								action: 'update',
							},
						],
					},
		resourceCounts: { create: 1, update: 0, retain: 0 },
		...overrides,
	}
}

function harness(input?: {
	head?: CourseSyncRevisionHead | null
	state?: CourseSyncPollState | null
	apply?: CourseSyncDetectionPollerDependencies['apply']
	stage?: CourseSyncDetectionPollerDependencies['stage']
}) {
	let state = input?.state ?? null
	const logs: CourseSyncPollLogInput[] = []
	const notifications: CourseSyncNotification[] = []
	const stage = vi.fn(
		input?.stage ?? (async () => run('staged')),
	)
	const preview = vi.fn(async () => run('previewed'))
	const apply = vi.fn(
		input?.apply ?? (async () => run('applied')),
	)
	const dependencies: CourseSyncDetectionPollerDependencies = {
		readManifest: async () => ({
			manifest,
			summary: {
				courseVersionId: 'version-2',
				manifest: { rev: 'dropbox-rev-2' },
			},
		}),
		getRevisionHead: async () => input?.head ?? null,
		getPollState: async () => state,
		savePollState: async (next) => {
			state = next
		},
		appendLog: async (entry) => {
			logs.push(entry)
		},
		stage,
		preview,
		apply,
		notify: async (notification) => {
			notifications.push(notification)
		},
		clock: () => new Date('2026-07-24T18:00:00.000Z'),
	}
	return {
		poll: createCourseSyncDetectionPoller(dependencies),
		stage,
		preview,
		apply,
		logs,
		notifications,
		state: () => state,
	}
}

describe('course sync detection poller', () => {
	it('records a no-op when the detected revision is already applied', async () => {
		const test = harness({
			head: {
				courseVersionId: 'version-2',
				providerRevision: 'dropbox-rev-2',
				runId: 'sync-run-2',
				runState: 'applied',
			},
		})

		await expect(test.poll('poll-1')).resolves.toMatchObject({
			outcome: 'no-op',
			courseVersionId: 'version-2',
		})
		expect(test.stage).not.toHaveBeenCalled()
		expect(test.notifications).toHaveLength(0)
		expect(test.logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: 'compare', outcome: 'skipped' }),
				expect.objectContaining({ stage: 'notify', outcome: 'skipped' }),
			]),
		)
	})

	it('stages, verifies, applies, and notifies a new revision', async () => {
		const test = harness({
			head: {
				courseVersionId: 'version-1',
				providerRevision: 'dropbox-rev-1',
				runId: 'sync-run-1',
				runState: 'applied',
			},
		})

		await expect(test.poll('poll-2')).resolves.toMatchObject({
			outcome: 'applied',
			controlPlaneRunId: 'sync-run-2',
		})
		expect(test.stage).toHaveBeenCalledWith(
			expect.objectContaining({
				providerRevision: 'dropbox-rev-2',
				idempotencyKey: 'course-sync-poll:version-2:dropbox-rev-2',
			}),
		)
		expect(test.preview).toHaveBeenCalledWith('sync-run-2')
		expect(test.apply).toHaveBeenCalledWith({
			runId: 'sync-run-2',
			idempotencyKey: 'course-sync-poll-apply:sync-run-2',
		})
		expect(test.notifications).toEqual([
			expect.objectContaining({
				kind: 'success',
				resourceCounts: { create: 1, update: 0, retain: 0 },
				mediaCount: 1,
			}),
		])
	})

	it('retries the same revision once, then holds at two strikes', async () => {
		const apply = vi.fn(async () => {
			throw new Error('database timeout')
		})
		const test = harness({
			head: {
				courseVersionId: 'version-2',
				providerRevision: 'dropbox-rev-2',
				runId: 'sync-run-2',
				runState: 'failed',
			},
			stage: async () => run('failed'),
			apply,
		})

		await expect(test.poll('poll-failure-1')).resolves.toMatchObject({
			outcome: 'failed',
			consecutiveFailures: 1,
		})
		await expect(test.poll('poll-failure-2')).resolves.toMatchObject({
			outcome: 'held',
			consecutiveFailures: 2,
		})
		await expect(test.poll('poll-held')).resolves.toMatchObject({
			outcome: 'held',
			consecutiveFailures: 2,
		})
		expect(apply).toHaveBeenCalledTimes(2)
		expect(test.logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: 'retry', outcome: 'started' }),
				expect.objectContaining({ stage: 'hold', outcome: 'held' }),
			]),
		)
	})

	it('builds the required success and failure notification payloads', () => {
		const success = buildCourseSyncNotificationPayload({
			kind: 'success',
			courseVersionId: 'version-2',
			providerRevision: 'dropbox-rev-2',
			runId: 'poll-2',
			controlPlaneRunId: 'sync-run-2',
			resourceCounts: { create: 3, update: 2, retain: 1 },
			mediaCount: 4,
			workshopEditUrl:
				'https://www.aihero.dev/workshops/ai-coding-crash-course/edit',
		})
		const failure = buildCourseSyncNotificationPayload({
			kind: 'failure',
			courseVersionId: 'version-2',
			providerRevision: 'dropbox-rev-2',
			runId: 'poll-failure',
			controlPlaneRunId: 'sync-run-2',
			failureClass: 'PLANETSCALE_TRANSACTION_TIMEOUT',
		})

		expect(success.attachments[0]?.text).toContain(
			'https://www.aihero.dev/workshops/ai-coding-crash-course/edit',
		)
		expect(success.attachments[0]?.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ title: 'Created', value: '3' }),
				expect.objectContaining({ title: 'Media updated', value: '4' }),
			]),
		)
		expect(failure.attachments[0]?.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: 'Failure class',
					value: 'PLANETSCALE_TRANSACTION_TIMEOUT',
				}),
			]),
		)
	})
})
