import type {
	CourseJsonDocumentV3,
	CourseSyncRunSummary,
} from '@ai-hero/course-sync-schema'
import { describe, expect, it, vi } from 'vitest'

import { CourseSyncError } from './errors'
import {
	freezeCourseSyncAssetBatch,
	type FreezeCourseSyncAsset,
} from './freeze-batches'
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
	freezeEffects: { sourceAssetsRead: 1, muxAssetsCreated: 1 },
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
	manifest?: CourseJsonDocumentV3
	head?: CourseSyncRevisionHead | null
	state?: CourseSyncPollState | null
	readManifest?: CourseSyncDetectionPollerDependencies['readManifest']
	apply?: CourseSyncDetectionPollerDependencies['apply']
	getRun?: CourseSyncDetectionPollerDependencies['getRun']
	ensureBinding?: CourseSyncDetectionPollerDependencies['ensureBinding']
	stage?: CourseSyncDetectionPollerDependencies['stage']
	freezeAsset?: FreezeCourseSyncAsset
	appendLog?: CourseSyncDetectionPollerDependencies['appendLog']
	evaluateBoundedAutoApply?: CourseSyncDetectionPollerDependencies['evaluateBoundedAutoApply']
	claimReviewNotification?: CourseSyncDetectionPollerDependencies['claimReviewNotification']
	completeReviewNotification?: CourseSyncDetectionPollerDependencies['completeReviewNotification']
	failReviewNotification?: CourseSyncDetectionPollerDependencies['failReviewNotification']
	verifyApplied?: CourseSyncDetectionPollerDependencies['verifyApplied']
	notify?: CourseSyncDetectionPollerDependencies['notify']
}) {
	let state = input?.state ?? null
	let head = input?.head ?? null
	const detectedManifest = input?.manifest ?? manifest
	const logs: CourseSyncPollLogInput[] = []
	const notifications: CourseSyncNotification[] = []
	const reviewNotificationState = new Map<
		string,
		'started' | 'succeeded' | 'failed'
	>()
	const stage = vi.fn(input?.stage ?? (async () => run('staged')))
	const preview = vi.fn(async () => run('previewed'))
	const apply = vi.fn(input?.apply ?? (async () => run('applied')))
	const getRun = vi.fn(
		input?.getRun ??
			(async () =>
				head ? run(head.runState, { runId: head.runId }) : run('previewed')),
	)
	const freezeAsset = vi.fn(input?.freezeAsset ?? (async () => frozenAsset))
	const freezeAssetBatch = vi.fn((batchInput) =>
		freezeCourseSyncAssetBatch(batchInput, freezeAsset),
	)
	const ensureBinding = vi.fn(input?.ensureBinding ?? (async () => undefined))
	const evaluateBoundedAutoApply = vi.fn(
		input?.evaluateBoundedAutoApply ??
			(async () => ({
				eligible: false as const,
				planSha256: 'plan-sha',
				reason: 'launch-policy-violation' as const,
				failureCode: 'LAUNCH_APPLY_POLICY_VIOLATION',
			})),
	)
	const claimReviewNotification = vi.fn(
		input?.claimReviewNotification ??
			(async ({ courseVersionId, planSha256 }) => {
				const key = `${courseVersionId}:${planSha256}`
				const state = reviewNotificationState.get(key)
				if (state === 'started' || state === 'succeeded') return false
				reviewNotificationState.set(key, 'started')
				return true
			}),
	)
	const completeReviewNotification = vi.fn(
		input?.completeReviewNotification ??
			(async ({ courseVersionId, planSha256 }) => {
				reviewNotificationState.set(
					`${courseVersionId}:${planSha256}`,
					'succeeded',
				)
			}),
	)
	const failReviewNotification = vi.fn(
		input?.failReviewNotification ??
			(async ({ courseVersionId, planSha256 }) => {
				reviewNotificationState.set(
					`${courseVersionId}:${planSha256}`,
					'failed',
				)
			}),
	)
	const notify = vi.fn(async (notification: CourseSyncNotification) => {
		await input?.notify?.(notification)
		notifications.push(notification)
	})
	const verifyApplied = vi.fn(
		input?.verifyApplied ?? (async () => run('applied')),
	)
	const dependencies: CourseSyncDetectionPollerDependencies = {
		readManifest:
			input?.readManifest ??
			(async () => ({
				manifest: detectedManifest,
				summary: {
					courseVersionId: detectedManifest.courseVersionId,
					manifest: { rev: 'dropbox-rev-2', sha256: 'b'.repeat(64) },
				},
			})),
		getRevisionHead: async () => head,
		getRun,
		getPollState: async () => state,
		ensureBinding,
		freezeAssetBatch,
		savePollState: async (next) => {
			state = next
		},
		appendLog: async (entry) => {
			logs.push(entry)
			await input?.appendLog?.(entry)
		},
		stage,
		preview,
		evaluateBoundedAutoApply,
		claimReviewNotification,
		completeReviewNotification,
		failReviewNotification,
		apply,
		verifyApplied,
		notify,
		clock: () => new Date('2026-07-24T18:00:00.000Z'),
	}
	return {
		poll: createCourseSyncDetectionPoller(dependencies),
		ensureBinding,
		freezeAsset,
		freezeAssetBatch,
		stage,
		preview,
		apply,
		verifyApplied,
		evaluateBoundedAutoApply,
		claimReviewNotification,
		completeReviewNotification,
		failReviewNotification,
		notify,
		getRun,
		logs,
		notifications,
		state: () => state,
		setHead: (next: CourseSyncRevisionHead | null) => {
			head = next
		},
	}
}

function failureHarness(initialState: CourseSyncPollState) {
	let state = initialState
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
	return {
		dependencies,
		logs,
		notifications,
		state: () => state,
		setState: (next: CourseSyncPollState) => {
			state = next
		},
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

	it('does not re-announce success when staging short-circuits to an applied run', async () => {
		const test = harness({
			stage: async () => run('applied', { noOp: true }),
		})

		await expect(test.poll('poll-noop-stage')).resolves.toMatchObject({
			outcome: 'no-op',
			courseVersionId: 'version-2',
		})
		expect(test.apply).not.toHaveBeenCalled()
		expect(test.notifications).toHaveLength(0)
		expect(test.state()).toMatchObject({
			status: 'succeeded',
			consecutiveFailures: 0,
			courseVersionId: 'version-2',
			providerRevision: 'dropbox-rev-2',
		})
		expect(test.logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					stage: 'notify',
					outcome: 'skipped',
					metadata: { reason: 'stage-no-op-already-applied' },
				}),
			]),
		)
	})

	it('never writes poll state from an environment without Dropbox configuration', async () => {
		const priorState: CourseSyncPollState = {
			bindingId: 'csb_ai_coding_crash_course',
			courseVersionId: 'version-2',
			providerRevision: 'dropbox-rev-2',
			status: 'succeeded',
			consecutiveFailures: 0,
			controlPlaneRunId: 'sync-run-2',
			failureClass: null,
			applyPolicyOverride: null,
			updatedAt: new Date('2026-07-24T17:30:00.000Z'),
		}
		const test = harness({
			state: priorState,
			readManifest: async () => {
				throw new CourseSyncError(
					'DROPBOX_SYNC_NOT_CONFIGURED',
					'Dropbox sync is not configured: DROPBOX_REFRESH_TOKEN',
					503,
				)
			},
		})

		await expect(test.poll('poll-unconfigured')).resolves.toMatchObject({
			outcome: 'failed',
			failureClass: 'DROPBOX_SYNC_NOT_CONFIGURED',
		})
		expect(test.state()).toEqual(priorState)
		expect(test.notifications).toHaveLength(0)
		expect(test.logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					outcome: 'failed',
					failureClass: 'DROPBOX_SYNC_NOT_CONFIGURED',
					metadata: expect.objectContaining({
						reason: 'environment-not-configured-poll-state-not-saved',
					}),
				}),
			]),
		)
	})

	it('restages the current source revision after its successful run was rolled back', async () => {
		const test = harness({
			head: {
				courseVersionId: 'version-2',
				providerRevision: 'dropbox-rev-2',
				runId: 'sync-run-2',
				runState: 'rolled_back',
			},
		})

		await expect(test.poll('poll-after-rollback')).resolves.toMatchObject({
			outcome: 'awaiting-apply',
		})
		expect(test.stage).toHaveBeenCalledOnce()
		expect(test.preview).toHaveBeenCalledOnce()
	})

	it('stages, previews, and waits for an operator without applying', async () => {
		const test = harness({
			head: {
				courseVersionId: 'version-1',
				providerRevision: 'dropbox-rev-1',
				runId: 'sync-run-1',
				runState: 'applied',
			},
		})

		await expect(test.poll('poll-2')).resolves.toMatchObject({
			outcome: 'awaiting-apply',
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
		expect(test.apply).not.toHaveBeenCalled()
		expect(test.state()).toMatchObject({
			status: 'awaiting-apply',
			controlPlaneRunId: 'sync-run-2',
			applyPolicyOverride: 'operator',
		})
		expect(test.notifications).toEqual([
			expect.objectContaining({
				kind: 'review',
				resourceCounts: { create: 1, update: 0, retain: 0 },
				mediaCount: 1,
			}),
		])
		// Later ticks stay quiet until the authenticated operator applies the run.
		test.setHead({
			courseVersionId: 'version-2',
			providerRevision: 'dropbox-rev-2',
			runId: 'sync-run-2',
			runState: 'previewed',
		})
		await expect(test.poll('poll-awaiting')).resolves.toMatchObject({
			outcome: 'awaiting-apply',
			controlPlaneRunId: 'sync-run-2',
		})
		expect(test.notifications).toHaveLength(1)

		test.setHead({
			courseVersionId: 'version-2',
			providerRevision: 'dropbox-rev-2',
			runId: 'sync-run-2',
			runState: 'applied',
		})
		await expect(test.poll('poll-applied-externally')).resolves.toMatchObject({
			outcome: 'no-op',
		})
		expect(test.state()).toMatchObject({ status: 'succeeded' })
	})

	it('auto-applies only a bounded eligible preview and verifies readback', async () => {
		const test = harness({
			head: {
				courseVersionId: 'version-1',
				providerRevision: 'dropbox-rev-1',
				runId: 'sync-run-1',
				runState: 'applied',
			},
			evaluateBoundedAutoApply: async () => ({
				eligible: true,
				planSha256: 'plan-sha',
			}),
		})

		await expect(test.poll('poll-auto')).resolves.toMatchObject({
			outcome: 'applied',
			controlPlaneRunId: 'sync-run-2',
		})
		expect(test.evaluateBoundedAutoApply).toHaveBeenCalledWith('sync-run-2')
		expect(test.apply).toHaveBeenCalledWith({
			runId: 'sync-run-2',
			idempotencyKey: 'course-sync-poll-apply:sync-run-2',
		})
		expect(test.verifyApplied).toHaveBeenCalledWith({
			runId: 'sync-run-2',
			planSha256: 'plan-sha',
		})
		expect(test.state()).toMatchObject({
			status: 'succeeded',
			controlPlaneRunId: 'sync-run-2',
			applyPolicyOverride: null,
		})
		expect(test.notifications).toEqual([
			expect.objectContaining({ kind: 'success' }),
		])
	})

	it('suppresses a yellow notification when its plan receipt already exists', async () => {
		const test = harness({
			head: {
				courseVersionId: 'version-1',
				providerRevision: 'dropbox-rev-1',
				runId: 'sync-run-1',
				runState: 'applied',
			},
			claimReviewNotification: async () => false,
		})

		await expect(test.poll('poll-duplicate-review')).resolves.toMatchObject({
			outcome: 'awaiting-apply',
		})
		expect(test.notifications).toHaveLength(0)
		expect(test.logs).toContainEqual(
			expect.objectContaining({
				stage: 'notify',
				outcome: 'skipped',
				metadata: expect.objectContaining({
					reason: 'duplicate-review-notification',
					planSha256: 'plan-sha',
				}),
			}),
		)
	})

	it('retries one failed yellow delivery and dedupes after completion', async () => {
		let attempts = 0
		const test = harness({
			head: {
				courseVersionId: 'version-1',
				providerRevision: 'dropbox-rev-1',
				runId: 'sync-run-1',
				runState: 'applied',
			},
			notify: async (notification) => {
				if (notification.kind === 'review' && attempts++ === 0) {
					throw new Error('injected Slack failure')
				}
			},
		})

		await expect(test.poll('poll-review-fails')).resolves.toMatchObject({
			outcome: 'awaiting-apply',
		})
		expect(test.failReviewNotification).toHaveBeenCalledOnce()
		expect(test.completeReviewNotification).not.toHaveBeenCalled()
		test.setHead({
			courseVersionId: 'version-2',
			providerRevision: 'dropbox-rev-2',
			runId: 'sync-run-2',
			runState: 'previewed',
		})

		await expect(test.poll('poll-review-retry')).resolves.toMatchObject({
			outcome: 'awaiting-apply',
		})
		expect(test.completeReviewNotification).toHaveBeenCalledOnce()
		await expect(test.poll('poll-review-deduped')).resolves.toMatchObject({
			outcome: 'awaiting-apply',
		})
		expect(test.notify).toHaveBeenCalledTimes(2)
		expect(test.notifications).toHaveLength(1)
	})

	it.each([
		['applying', 'in-progress', 'applying'],
		['failed', 'held', 'held'],
		['rolled_back', 'held', 'held'],
		['superseded', 'held', 'held'],
	] as const)(
		'reconciles awaiting-apply when the current run is %s',
		async (runState, expectedOutcome, expectedStatus) => {
			const awaitingState: CourseSyncPollState = {
				bindingId: 'csb_ai_coding_crash_course',
				courseVersionId: 'version-2',
				providerRevision: 'dropbox-rev-2',
				status: 'awaiting-apply',
				consecutiveFailures: 0,
				controlPlaneRunId: 'sync-run-2',
				failureClass: null,
				applyPolicyOverride: 'operator',
				updatedAt: new Date('2026-07-24T17:00:00.000Z'),
			}
			const test = harness({
				state: awaitingState,
				head: {
					courseVersionId: 'version-2',
					providerRevision: 'dropbox-rev-2',
					runId: 'sync-run-2',
					runState,
				},
				getRun: async () => run(runState),
			})

			await expect(test.poll(`poll-${runState}`)).resolves.toMatchObject({
				outcome: expectedOutcome,
				controlPlaneRunId: 'sync-run-2',
			})
			expect(test.state()).toMatchObject({ status: expectedStatus })
			expect(test.stage).not.toHaveBeenCalled()
			if (
				runState === 'failed' ||
				runState === 'rolled_back' ||
				runState === 'superseded'
			) {
				expect(test.notifications).toHaveLength(1)
			}
		},
	)

	it('holds a serialized target failure immediately and keeps run IDs honest', async () => {
		const serializedFailure = new CourseSyncError(
			'TARGET_CONTRACT_MISMATCH',
			'Target contract mismatch: state expected published, actual draft.',
			409,
			{ category: 'target_precondition', retryable: false },
		)
		const test = harness({
			head: {
				courseVersionId: 'version-1',
				providerRevision: 'dropbox-rev-1',
				runId: 'sync-run-1',
				runState: 'applied',
			},
			freezeAsset: async () => {
				throw serializedFailure
			},
		})

		await expect(test.poll('poll-target-failure')).resolves.toMatchObject({
			outcome: 'held',
			consecutiveFailures: 1,
			controlPlaneRunId: null,
			failureClass: 'TARGET_CONTRACT_MISMATCH',
		})
		expect(test.stage).not.toHaveBeenCalled()
		expect(test.apply).not.toHaveBeenCalled()
		expect(test.notifications).toEqual([
			expect.objectContaining({
				kind: 'failure',
				controlPlaneRunId: null,
				summary: expect.objectContaining({
					retryable: false,
					currentRunCreated: false,
					previousAppliedRunId: 'sync-run-1',
					sideEffects: {
						sourceAssetsRead: { count: 0, precision: 'at-least' },
						muxAssetsCreated: { count: 0, precision: 'at-least' },
						targetWrites: 'none',
					},
				}),
			}),
		])
	})

	it('reports partial freeze side effects as a lower bound, never false', async () => {
		const firstLesson = manifest.sections[0]!.lessons[0]!
		if (firstLesson.type !== 'explainer') throw new Error('fixture mismatch')
		const twoVideoManifest: CourseJsonDocumentV3 = {
			...manifest,
			sections: [
				{
					...manifest.sections[0]!,
					lessons: [
						...manifest.sections[0]!.lessons,
						{
							type: 'explainer',
							id: 'lesson-2',
							title: 'Lesson 2',
							explainer: {
								...firstLesson.explainer,
								id: 'video-2',
								relativePath: 'video-2.mp4',
							},
						},
					],
				},
			],
		}
		let calls = 0
		const test = harness({
			manifest: twoVideoManifest,
			freezeAsset: async (input) => {
				calls += 1
				if (calls === 2) throw new Error('Mux timed out after create')
				return { ...frozenAsset, sourceVideoId: input.sourceVideoId }
			},
			state: {
				bindingId: 'csb_ai_coding_crash_course',
				courseVersionId: 'version-2',
				providerRevision: 'dropbox-rev-2',
				status: 'failed',
				consecutiveFailures: 1,
				controlPlaneRunId: null,
				failureClass: 'MUX_API_FAILED',
				applyPolicyOverride: null,
				updatedAt: new Date('2026-07-24T15:00:00.000Z'),
			},
		})

		await expect(test.poll('poll-freeze-partial')).resolves.toMatchObject({
			outcome: 'held',
		})
		expect(test.notifications[0]).toMatchObject({
			kind: 'failure',
			summary: {
				sideEffects: {
					sourceAssetsRead: { count: 1, precision: 'at-least' },
					muxAssetsCreated: { count: 1, precision: 'at-least' },
					targetWrites: 'none',
				},
			},
		})
	})

	it('retries one transient freeze failure, then holds at two strikes', async () => {
		const freezeAsset = vi.fn(async () => {
			throw new Error('database timeout')
		})
		const test = harness({
			head: {
				courseVersionId: 'version-1',
				providerRevision: 'dropbox-rev-1',
				runId: 'sync-run-1',
				runState: 'applied',
			},
			freezeAsset,
		})

		await expect(test.poll('poll-failure-1')).resolves.toMatchObject({
			outcome: 'failed',
			consecutiveFailures: 1,
		})
		expect(test.notifications).toHaveLength(0)
		await expect(test.poll('poll-failure-2')).resolves.toMatchObject({
			outcome: 'held',
			consecutiveFailures: 2,
		})
		expect(test.notifications).toEqual([
			expect.objectContaining({ kind: 'failure' }),
		])
		await expect(test.poll('poll-held')).resolves.toMatchObject({
			outcome: 'held',
			consecutiveFailures: 2,
		})
		expect(test.notifications).toHaveLength(1)
		expect(freezeAsset).toHaveBeenCalledTimes(2)
		expect(test.apply).not.toHaveBeenCalled()
		expect(test.logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: 'retry', outcome: 'started' }),
				expect.objectContaining({ stage: 'hold', outcome: 'held' }),
			]),
		)
	})

	it('does not page again when the main-loop catch sees the same held revision', async () => {
		const test = harness({
			state: {
				bindingId: 'csb_ai_coding_crash_course',
				courseVersionId: 'version-2',
				providerRevision: 'dropbox-rev-2',
				status: 'held',
				consecutiveFailures: 2,
				controlPlaneRunId: 'sync-run-2',
				failureClass: 'Error',
				applyPolicyOverride: null,
				updatedAt: new Date('2026-07-24T17:00:00.000Z'),
			},
			appendLog: async (entry) => {
				if (entry.stage === 'compare' && entry.outcome === 'succeeded') {
					throw new Error('log write failed')
				}
			},
		})

		await expect(test.poll('poll-held-catch')).resolves.toMatchObject({
			outcome: 'held',
			consecutiveFailures: 2,
		})
		expect(test.notifications).toHaveLength(0)
		expect(test.logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					stage: 'notify',
					outcome: 'skipped',
					metadata: { reason: 'already-held' },
				}),
			]),
		)
	})

	it('migrates the server binding without letting a new revision bypass an operator hold', async () => {
		const order: string[] = []
		const test = harness({
			state: {
				bindingId: 'csb_ai_coding_crash_course',
				courseVersionId: 'version-1',
				providerRevision: 'dropbox-rev-1',
				status: 'held',
				consecutiveFailures: 2,
				controlPlaneRunId: 'sync-run-1',
				failureClass: 'Error',
				applyPolicyOverride: null,
				updatedAt: new Date('2026-07-24T17:00:00.000Z'),
			},
			ensureBinding: async () => {
				order.push('ensure-binding')
			},
			appendLog: async (entry) => {
				if (entry.stage === 'hold' && entry.outcome === 'held') {
					order.push('hold-log')
				}
			},
		})

		await expect(test.poll('new-revision-held')).resolves.toMatchObject({
			outcome: 'held',
			consecutiveFailures: 2,
			controlPlaneRunId: null,
		})
		expect(test.ensureBinding).toHaveBeenCalledOnce()
		expect(order).toEqual(['ensure-binding', 'hold-log'])
		expect(test.freezeAsset).not.toHaveBeenCalled()
		expect(test.stage).not.toHaveBeenCalled()
		expect(test.notifications).toHaveLength(0)
	})

	it('preserves operator review across a released strike-one retry', async () => {
		let failOnce = true
		const test = harness({
			state: {
				bindingId: 'csb_ai_coding_crash_course',
				courseVersionId: 'version-2',
				providerRevision: 'dropbox-rev-2',
				status: 'released',
				consecutiveFailures: 0,
				controlPlaneRunId: null,
				failureClass: null,
				applyPolicyOverride: 'operator',
				updatedAt: new Date('2026-07-24T17:00:00.000Z'),
			},
			freezeAsset: async () => {
				if (failOnce) {
					failOnce = false
					throw new Error('injected strike one')
				}
				return frozenAsset
			},
			evaluateBoundedAutoApply: async () => ({
				eligible: true,
				planSha256: 'plan-sha',
			}),
		})

		await expect(test.poll('released-strike-one')).resolves.toMatchObject({
			outcome: 'failed',
			consecutiveFailures: 1,
		})
		expect(test.state()).toMatchObject({
			status: 'failed',
			applyPolicyOverride: 'operator',
		})

		await expect(test.poll('released-retry')).resolves.toMatchObject({
			outcome: 'awaiting-apply',
			controlPlaneRunId: 'sync-run-2',
		})
		expect(test.preview).toHaveBeenCalledOnce()
		expect(test.apply).not.toHaveBeenCalled()
		expect(test.state()).toMatchObject({
			status: 'awaiting-apply',
			applyPolicyOverride: 'operator',
		})

		test.setHead({
			courseVersionId: 'version-2',
			providerRevision: 'dropbox-rev-2',
			runId: 'sync-run-2',
			runState: 'applied',
		})
		await expect(test.poll('released-applied-by-operator')).resolves.toMatchObject({
			outcome: 'no-op',
		})
		expect(test.state()).toMatchObject({
			status: 'succeeded',
			applyPolicyOverride: null,
		})
	})

	it('consumes operator review after a verified staging no-op', async () => {
		const test = harness({
			state: {
				bindingId: 'csb_ai_coding_crash_course',
				courseVersionId: 'version-2',
				providerRevision: 'dropbox-rev-2',
				status: 'released',
				consecutiveFailures: 0,
				controlPlaneRunId: null,
				failureClass: null,
				applyPolicyOverride: 'operator',
				updatedAt: new Date('2026-07-24T17:00:00.000Z'),
			},
			stage: async () => run('applied', { noOp: true }),
		})

		await expect(test.poll('released-no-op')).resolves.toMatchObject({
			outcome: 'no-op',
		})
		expect(test.apply).not.toHaveBeenCalled()
		expect(test.state()).toMatchObject({
			status: 'succeeded',
			applyPolicyOverride: null,
		})
	})

	it('requires operator review after release and across superseding revisions', async () => {
		const test = harness({
			state: {
				bindingId: 'csb_ai_coding_crash_course',
				courseVersionId: 'version-1',
				providerRevision: 'dropbox-rev-1',
				status: 'released',
				consecutiveFailures: 0,
				controlPlaneRunId: null,
				failureClass: null,
				applyPolicyOverride: 'operator',
				updatedAt: new Date('2026-07-24T17:00:00.000Z'),
			},
			evaluateBoundedAutoApply: async () => ({
				eligible: true,
				planSha256: 'plan-sha',
			}),
		})

		await expect(test.poll('released-revision')).resolves.toMatchObject({
			outcome: 'awaiting-apply',
		})
		expect(test.stage).toHaveBeenCalledOnce()
		expect(test.preview).toHaveBeenCalledOnce()
		expect(test.evaluateBoundedAutoApply).toHaveBeenCalledOnce()
		expect(test.apply).not.toHaveBeenCalled()
		expect(test.state()).toMatchObject({
			status: 'awaiting-apply',
			consecutiveFailures: 0,
		})

		const superseding = harness({
			manifest: { ...manifest, courseVersionId: 'version-3' },
			state: test.state(),
			evaluateBoundedAutoApply: async () => ({
				eligible: true,
				planSha256: 'plan-sha',
			}),
		})
		await expect(superseding.poll('superseding-revision')).resolves.toMatchObject(
			{ outcome: 'awaiting-apply', courseVersionId: 'version-3' },
		)
		expect(superseding.stage).toHaveBeenCalledOnce()
		expect(superseding.apply).not.toHaveBeenCalled()
		expect(superseding.verifyApplied).not.toHaveBeenCalled()
		expect(superseding.state()).toMatchObject({
			courseVersionId: 'version-3',
			status: 'awaiting-apply',
		})
	})

	it('continues after an interrupted batch sequence without duplicate assets or runs', async () => {
		const firstLesson = manifest.sections[0]!.lessons[0]!
		if (firstLesson.type !== 'explainer') throw new Error('fixture mismatch')
		const sourceVideoIds = Array.from(
			{ length: 12 },
			(_, index) => `video-${index + 1}`,
		)
		const batchManifest: CourseJsonDocumentV3 = {
			...manifest,
			sections: [
				{
					...manifest.sections[0]!,
					lessons: sourceVideoIds.map((sourceVideoId, index) => ({
						...firstLesson,
						id: `lesson-${index + 1}`,
						explainer: {
							...firstLesson.explainer,
							id: sourceVideoId,
							relativePath: `${sourceVideoId}.mp4`,
							sha256: String(index + 1).padStart(64, 'a'),
						},
					})),
				},
			],
		}
		const receipts = new Map<string, typeof frozenAsset>()
		const muxCreates: string[] = []
		let interrupt = true
		const test = harness({
			manifest: batchManifest,
			freezeAsset: async ({ sourceVideoId }) => {
				const receipt = receipts.get(sourceVideoId)
				if (receipt) {
					return {
						...receipt,
						freezeEffects: { sourceAssetsRead: 0, muxAssetsCreated: 0 },
					}
				}
				if (sourceVideoId === 'video-4' && interrupt) {
					interrupt = false
					throw new Error('injected interruption')
				}
				const asset = {
					...frozenAsset,
					sourceVideoId,
					relativePath: `${sourceVideoId}.mp4`,
					muxAssetId: `mux-${sourceVideoId}`,
					muxPlaybackId: `playback-${sourceVideoId}`,
				}
				receipts.set(sourceVideoId, asset)
				muxCreates.push(sourceVideoId)
				return asset
			},
		})

		await expect(test.poll('poll-interrupted')).resolves.toMatchObject({
			outcome: 'failed',
			consecutiveFailures: 1,
		})
		expect(test.stage).not.toHaveBeenCalled()
		expect(test.logs).toContainEqual(
			expect.objectContaining({
				outcome: 'failed',
				metadata: expect.objectContaining({
					failureSummary: expect.objectContaining({
						sideEffects: expect.objectContaining({
							muxAssetsCreated: { count: 3, precision: 'at-least' },
						}),
					}),
				}),
			}),
		)

		await expect(test.poll('poll-continued')).resolves.toMatchObject({
			outcome: 'awaiting-apply',
			controlPlaneRunId: 'sync-run-2',
		})
		const durableBatchSizes = test.freezeAssetBatch.mock.calls.map(
			([input]) => input.sourceVideoIds.length,
		)
		expect(durableBatchSizes).toHaveLength(16)
		expect(new Set(durableBatchSizes)).toEqual(new Set([1]))
		expect(muxCreates).toEqual(sourceVideoIds)
		expect(new Set(muxCreates).size).toBe(12)
		expect(test.stage).toHaveBeenCalledOnce()
		const stagedAssets = test.stage.mock.calls[0]![0].frozenAssets
		expect(stagedAssets.map((asset) => asset.sourceVideoId)).toEqual(
			sourceVideoIds,
		)
		expect(new Set(stagedAssets.map((asset) => asset.sourceVideoId)).size).toBe(
			12,
		)
	})

	it.each(['batching', 'staging'] as const)(
		'resumes a persisted %s marker immediately from frozen receipts',
		async (status) => {
			const test = harness({
				state: {
					bindingId: 'csb_ai_coding_crash_course',
					courseVersionId: 'version-2',
					providerRevision: 'dropbox-rev-2',
					status,
					consecutiveFailures: 0,
					controlPlaneRunId: null,
					failureClass: null,
					applyPolicyOverride: null,
					updatedAt: new Date('2026-07-24T17:59:59.000Z'),
				},
			})

			await expect(test.poll(`poll-resume-${status}`)).resolves.toMatchObject({
				outcome: 'awaiting-apply',
				courseVersionId: 'version-2',
			})
			expect(test.freezeAsset).toHaveBeenCalledOnce()
			expect(test.stage).toHaveBeenCalledOnce()
			expect(test.logs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						stage: 'stage',
						outcome: 'started',
						metadata: { mode: 'resumable-batches', resuming: true },
					}),
				]),
			)
		},
	)

	it('pages once when a killed run transitions into held', async () => {
		const initialState: CourseSyncPollState = {
			bindingId: 'csb_ai_coding_crash_course',
			courseVersionId: 'version-2',
			providerRevision: 'dropbox-rev-2',
			status: 'staging',
			consecutiveFailures: 0,
			controlPlaneRunId: null,
			failureClass: null,
			applyPolicyOverride: null,
			updatedAt: new Date('2026-07-24T18:00:00.000Z'),
		}
		const test = failureHarness(initialState)

		await recordCourseSyncPollFailure(test.dependencies, {
			runId: 'killed-1',
			occurredAt: new Date('2026-07-24T18:01:00.000Z'),
		})
		expect(test.notifications).toHaveLength(0)
		await recordCourseSyncPollFailure(test.dependencies, {
			runId: 'killed-2',
			occurredAt: new Date('2026-07-24T18:02:00.000Z'),
		})

		expect(test.state()).toMatchObject({
			status: 'held',
			consecutiveFailures: 2,
			failureClass: 'POLL_RUN_KILLED',
		})
		expect(test.logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: 'hold', outcome: 'held' }),
				expect.objectContaining({
					stage: 'notify',
					outcome: 'skipped',
					metadata: { reason: 'first-failure-will-retry' },
				}),
			]),
		)
		expect(test.notifications).toEqual([
			expect.objectContaining({ kind: 'failure' }),
		])
	})

	it('does not restore a hold when operator release wins an onFailure race', async () => {
		const releasedState: CourseSyncPollState = {
			bindingId: 'csb_ai_coding_crash_course',
			courseVersionId: 'version-2',
			providerRevision: 'dropbox-rev-2',
			status: 'released',
			consecutiveFailures: 0,
			controlPlaneRunId: null,
			failureClass: null,
			applyPolicyOverride: 'operator',
			updatedAt: new Date('2026-07-24T18:00:00.000Z'),
		}
		const test = failureHarness(releasedState)

		await expect(
			recordCourseSyncPollFailure(test.dependencies, {
				runId: 'old-failed-poll',
			}),
		).resolves.toEqual({ held: false, consecutiveFailures: 0 })
		expect(test.state()).toEqual(releasedState)
		expect(test.notifications).toHaveLength(0)
		expect(test.logs).toEqual([
			expect.objectContaining({
				stage: 'notify',
				outcome: 'skipped',
				metadata: { reason: 'operator-release-won-race' },
			}),
		])
	})

	it('skips notification when a killed run is already held', async () => {
		const test = failureHarness({
			bindingId: 'csb_ai_coding_crash_course',
			courseVersionId: 'version-2',
			providerRevision: 'dropbox-rev-2',
			status: 'held',
			consecutiveFailures: 2,
			controlPlaneRunId: null,
			failureClass: 'POLL_RUN_KILLED',
			applyPolicyOverride: null,
			updatedAt: new Date('2026-07-24T18:00:00.000Z'),
		})

		await recordCourseSyncPollFailure(test.dependencies, {
			runId: 'killed-while-held',
			occurredAt: new Date('2026-07-24T18:30:00.000Z'),
		})

		expect(test.notifications).toHaveLength(0)
		expect(test.state()).toMatchObject({
			status: 'held',
			consecutiveFailures: 2,
		})
		expect(test.logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					stage: 'notify',
					outcome: 'skipped',
					metadata: { reason: 'already-held' },
				}),
			]),
		)
	})

	it('pages again after success resets the killed-run strikes', async () => {
		const heldState: CourseSyncPollState = {
			bindingId: 'csb_ai_coding_crash_course',
			courseVersionId: 'version-2',
			providerRevision: 'dropbox-rev-2',
			status: 'held',
			consecutiveFailures: 2,
			controlPlaneRunId: null,
			failureClass: 'POLL_RUN_KILLED',
			applyPolicyOverride: null,
			updatedAt: new Date('2026-07-24T18:00:00.000Z'),
		}
		const test = failureHarness(heldState)
		test.setState({
			...heldState,
			status: 'succeeded',
			consecutiveFailures: 0,
			failureClass: null,
		})

		await recordCourseSyncPollFailure(test.dependencies, {
			runId: 'fresh-kill-1',
		})
		expect(test.notifications).toHaveLength(0)
		await recordCourseSyncPollFailure(test.dependencies, {
			runId: 'fresh-kill-2',
		})

		expect(test.notifications).toEqual([
			expect.objectContaining({ kind: 'failure' }),
		])
	})

	it('builds human success and failure notification payloads with permalinks', () => {
		const courseVersionId = '98479f85-7dc8-4053-83da-7f4d2df1a195'
		const manifestSha256 = 'b'.repeat(64)
		const success = buildCourseSyncNotificationPayload({
			kind: 'success',
			courseVersionId,
			courseName: 'AI Coding Crash Course',
			providerRevision: 'dropbox-rev-2',
			manifestSha256,
			runId: 'poll-2',
			controlPlaneRunId: 'sync-run-2',
			resourceCounts: { create: 3, update: 2, retain: 1 },
			structureCounts: { sections: 4, lessons: 39, videos: 47 },
			durationSeconds: 31 * 60,
			mediaCount: 4,
			workshopEditUrl:
				'https://www.aihero.dev/workshops/ai-coding-crash-course/edit',
		})
		const failure = buildCourseSyncNotificationPayload({
			kind: 'failure',
			outcome: 'held',
			courseVersionId,
			courseName: 'AI Coding Crash Course',
			providerRevision: 'dropbox-rev-2',
			manifestSha256,
			runId: 'poll-failure',
			controlPlaneRunId: 'sync-run-2',
			stage: 'apply',
			failureClass: 'PLANETSCALE_TRANSACTION_TIMEOUT',
			reason: 'The database transaction timed out.',
			summary: {
				code: 'PLANETSCALE_TRANSACTION_TIMEOUT',
				actual: ['Dependency or internal operation failed.'],
				expected: ['Operation completes within its retry policy.'],
				retryable: true,
				sideEffects: {
					sourceAssetsRead: { count: 17, precision: 'at-least' },
					muxAssetsCreated: { count: 17, precision: 'at-least' },
					targetWrites: 'rolled-back',
				},
				currentRunCreated: true,
				previousAppliedRunId: 'sync-run-1',
			},
		})

		expect(success.text).toBe(
			'Synced AI Coding Crash Course (98479f85) into the bound workshop: 4 sections, 39 lessons, 47 videos, 31 min. http://localhost:3000/admin/course-sync/98479f85-7dc8-4053-83da-7f4d2df1a195',
		)
		expect(success.attachments[0]?.text).toContain(
			'https://www.aihero.dev/workshops/ai-coding-crash-course/edit',
		)
		expect(success.attachments[0]?.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: 'Manifest SHA',
					value: 'bbbbbbbbbbbb',
				}),
				expect.objectContaining({ title: 'Created', value: '3' }),
				expect.objectContaining({ title: 'Media updated', value: '4' }),
			]),
		)
		expect(failure.text).toBe(
			'Course sync held while apply AI Coding Crash Course (98479f85): The database transaction timed out. It exhausted the retry policy and is holding for an operator. http://localhost:3000/admin/course-sync/98479f85-7dc8-4053-83da-7f4d2df1a195',
		)
		expect(failure.attachments[0]?.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: 'Failure class',
					value: 'PLANETSCALE_TRANSACTION_TIMEOUT',
				}),
				expect.objectContaining({ title: 'Retryable', value: 'yes' }),
				expect.objectContaining({
					title: 'Current sync run',
					value: 'sync-run-2',
				}),
				expect.objectContaining({
					title: 'Previous applied run',
					value: 'sync-run-1',
				}),
			]),
		)
	})
})
