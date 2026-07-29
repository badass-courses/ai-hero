import type {
	CourseJsonDocumentV3,
	CourseSyncRunSummary,
} from '@ai-hero/course-sync-schema'
import { describe, expect, it, vi } from 'vitest'

import {
	buildCourseSyncNotificationPayload,
	createCourseSyncDetectionPoller,
	recordCourseSyncPollFailure,
	type CourseSyncDetectionPollerDependencies,
	type CourseSyncNotification,
	type CourseSyncPollLogInput,
	type CourseSyncPollState,
	type CourseSyncRevisionHead,
} from './detection-poller'

const manifest = {
	$schema: 'course.schema.json',
	schemaVersion: 3,
	courseId: '50385098-a712-486f-b777-1f76ef31e9e5',
	courseVersionId: 'version-2',
	archiveTTL: '90d',
	courseName: 'Fixture Course',
	sections: [
		{
			id: 'section-1',
			title: 'Section 1',
			lessons: [
				{
					type: 'explainer',
					id: 'lesson-1',
					title: 'Lesson 1',
					explainer: {
						id: 'video-1',
						relativePath: 'video-1.mp4',
						sha256: 'a'.repeat(64),
						bytes: 10,
						body: 'Body',
						description: 'Description',
						hash: 'render-1',
						chapters: [],
					},
				},
			],
		},
	],
} as CourseJsonDocumentV3

const frozenAsset = {
	sourceVideoId: 'video-1',
	relativePath: 'video-1.mp4',
	providerRevision: 'asset-rev-1',
	providerContentHash: null,
	producerSha256: 'a'.repeat(64),
	bytes: 10,
	snapshotUri: null,
	muxAssetId: 'mux-1',
	muxPlaybackId: 'playback-1',
	duration: 60,
}

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
	const freezeAsset = vi.fn(async () => frozenAsset)
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
		freezeAsset,
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
		freezeAsset,
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
		expect(test.freezeAsset).toHaveBeenCalledWith({
			bindingId: 'csb_ai_coding_crash_course',
			manifest,
			sourceVideoId: 'video-1',
		})
		expect(test.stage).toHaveBeenCalledWith(
			expect.objectContaining({
				providerRevision: 'dropbox-rev-2',
				idempotencyKey: 'course-sync-poll:version-2:dropbox-rev-2',
				frozenAssets: [frozenAsset],
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

	it('skips a queued tick while a fresh staging marker exists', async () => {
		const test = harness({
			state: {
				bindingId: 'csb_ai_coding_crash_course',
				courseVersionId: 'version-2',
				providerRevision: 'dropbox-rev-2',
				status: 'staging',
				consecutiveFailures: 0,
				controlPlaneRunId: null,
				failureClass: null,
				updatedAt: new Date('2026-07-24T17:00:00.000Z'),
			},
		})

		await expect(test.poll('poll-queued')).resolves.toEqual({
			outcome: 'in-progress',
			courseVersionId: 'version-2',
			runId: 'poll-queued',
		})
		expect(test.freezeAsset).not.toHaveBeenCalled()
		expect(test.stage).not.toHaveBeenCalled()
		expect(test.logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					stage: 'stage',
					outcome: 'skipped',
					metadata: { reason: 'freeze-sweep-in-progress' },
				}),
			]),
		)
	})

	it('accounts for silent poll death and holds on the second strike', async () => {
		let state: CourseSyncPollState = {
			bindingId: 'csb_ai_coding_crash_course',
			courseVersionId: 'version-2',
			providerRevision: 'dropbox-rev-2',
			status: 'staging',
			consecutiveFailures: 0,
			controlPlaneRunId: null,
			failureClass: null,
			updatedAt: new Date('2026-07-24T18:00:00.000Z'),
		}
		const logs: CourseSyncPollLogInput[] = []
		const notifications: CourseSyncNotification[] = []
		const dependencies = {
			getPollState: async () => state,
			savePollState: async (next: CourseSyncPollState) => {
				state = next
			},
			appendLog: async (entry: CourseSyncPollLogInput) => {
				logs.push(entry)
			},
			notify: async (notification: CourseSyncNotification) => {
				notifications.push(notification)
			},
		}

		await recordCourseSyncPollFailure(dependencies, {
			runId: 'killed-1',
			occurredAt: new Date('2026-07-24T18:01:00.000Z'),
		})
		await recordCourseSyncPollFailure(dependencies, {
			runId: 'killed-2',
			occurredAt: new Date('2026-07-24T18:02:00.000Z'),
		})

		expect(state).toMatchObject({
			status: 'held',
			consecutiveFailures: 2,
			failureClass: 'POLL_RUN_KILLED',
		})
		expect(logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: 'hold', outcome: 'held' }),
			]),
		)
		expect(notifications).toHaveLength(2)
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
		expect(failure.text).toContain(
			'failure=PLANETSCALE_TRANSACTION_TIMEOUT; poll=poll-failure; sync=sync-run-2; courseVersionId=version-2',
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
