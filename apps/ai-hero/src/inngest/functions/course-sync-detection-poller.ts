import {
	deliverCourseSyncAppliedNotice,
	sendCourseSyncSlackPayload,
} from '@/course-sync/applied-notice'
import {
	appendCourseSyncPollLog,
	claimCourseSyncReviewNotification,
	completeCourseSyncReviewNotification,
	failCourseSyncReviewNotification,
	getCourseSyncPollState,
	getCourseSyncRevisionHead,
	saveCourseSyncPollState,
} from '@/course-sync/detection-persistence'
import {
	buildCourseSyncNotificationPayload,
	createCourseSyncDetectionPoller,
	recordCourseSyncPollFailure,
	type CourseSyncNotification,
} from '@/course-sync/detection-poller'
import {
	CourseSyncError,
	captureCourseSyncStepResult,
	unwrapCourseSyncStepResult,
	type CourseSyncStepResult,
} from '@/course-sync/errors'
import { freezeCourseSyncAssetBatch } from '@/course-sync/freeze-batches'
import { dropboxSyncConfigFor } from '@/course-sync/dropbox-binding-config'
import { courseSyncControlPlane } from '@/course-sync/runtime'
import {
	AI_HERO_COURSE_SYNC_BINDING,
	getServerCourseSyncBinding,
} from '@/course-sync/types'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'
import { readDropboxCourseManifest } from '@/lib/dropbox-course-sync'

import { COURSE_SYNC_POLL_REQUESTED_EVENT } from '../events/course-sync-poll'
import { inngest } from '../inngest.server'

async function notifyCourseSync(
	notification: CourseSyncNotification,
	bindingId: string,
) {
	// Applied is a state, not an event of this poller. Every caller that moves a
	// run to applied delivers through the same claimed path, so an operator
	// apply and a poller apply produce one identical notice.
	if (notification.kind === 'success') {
		await deliverCourseSyncAppliedNotice({
			bindingId,
			controlPlaneRunId: notification.controlPlaneRunId,
			pollRunId: notification.runId,
			notification,
		})
		return
	}
	// Reviews and failures keep their deterministic wording because those
	// messages are read under pressure and must not vary.
	await sendCourseSyncSlackPayload(
		buildCourseSyncNotificationPayload(notification, null),
	)
}

function originalFailureRunId(event: unknown, fallback: string) {
	if (!event || typeof event !== 'object' || !('data' in event)) return fallback
	const data = (event as { data?: unknown }).data
	if (!data || typeof data !== 'object' || !('run_id' in data)) return fallback
	const runId = (data as { run_id?: unknown }).run_id
	return typeof runId === 'string' && runId ? runId : fallback
}

function originalFailureEvent(event: unknown): unknown {
	if (!event || typeof event !== 'object' || !('data' in event))
		return undefined
	const failureData = (event as { data?: unknown }).data
	if (
		!failureData ||
		typeof failureData !== 'object' ||
		!('event' in failureData)
	)
		return undefined
	return (failureData as { event?: unknown }).event
}

export function originalFailureBindingId(event: unknown): string | null {
	const original = originalFailureEvent(event)
	if (!original || typeof original !== 'object' || !('data' in original))
		return null
	const data = (original as { data?: unknown }).data
	if (!data || typeof data !== 'object' || !('bindingId' in data)) return null
	const bindingId = (data as { bindingId?: unknown }).bindingId
	return typeof bindingId === 'string' && bindingId ? bindingId : null
}

function resolvePollBindingId(event: unknown): {
	bindingId: string
	legacy: boolean
} {
	if (event && typeof event === 'object' && 'data' in event) {
		const data = (event as { data?: unknown }).data
		if (data && typeof data === 'object' && 'bindingId' in data) {
			const bindingId = (data as { bindingId?: unknown }).bindingId
			if (typeof bindingId !== 'string') {
				throw new CourseSyncError(
					'BINDING_NOT_FOUND',
					'Sync binding not found.',
					404,
				)
			}
			return { bindingId, legacy: false }
		}
	}
	// TODO: remove after one full deploy cycle with zero legacy_cron_compat hits.
	// Before this deploy, Crash Course was the only registered binding.
	return { bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId, legacy: true }
}

async function logLegacyPoll(
	runId: string,
	phase: 'poll' | 'failure',
	bindingId: string,
) {
	await log.info('course_sync.legacy_cron_compat', {
		runId,
		phase,
		bindingId,
	})
}

export const courseSyncDetectionPoller = inngest.createFunction(
	{
		id: 'ai-hero-course-sync-detection-poller',
		name: 'AI Hero Course Sync Detection Poller',
		concurrency: { limit: 1, key: 'event.data.bindingId' },
		retries: 0,
		onFailure: async ({ event, step, runId }) => {
			const { bindingId, legacy } = resolvePollBindingId(
				originalFailureEvent(event),
			)
			const binding = getServerCourseSyncBinding(bindingId)
			const failedRunId = originalFailureRunId(event, runId)
			if (legacy) await logLegacyPoll(failedRunId, 'failure', bindingId)
			await recordCourseSyncPollFailure(
				{
					binding,
					getPollState: async (bindingId) => {
						const state = await step.run(
							'load-failed-course-sync-poll-state',
							() => getCourseSyncPollState(bindingId),
						)
						return state
							? { ...state, updatedAt: new Date(state.updatedAt) }
							: null
					},
					savePollState: async (state) => {
						await step.run('save-failed-course-sync-poll-state', () =>
							saveCourseSyncPollState({
								...state,
								updatedAt: new Date(state.updatedAt),
							}),
						)
					},
					appendLog: async (input) => {
						await step.run(`append-failed-course-sync-log-${input.stage}`, () =>
							appendCourseSyncPollLog({
								...input,
								occurredAt: new Date(input.occurredAt),
							}),
						)
					},
					notify: async (notification) => {
						await step.run('notify-course-sync-failure', () =>
							notifyCourseSync(notification, bindingId),
						)
					},
				},
				{
					bindingId,
					runId: failedRunId,
					failureClass: 'POLL_RUN_KILLED',
				},
			)
		},
	},
	{ event: COURSE_SYNC_POLL_REQUESTED_EVENT },
	async ({ event, step, runId }) => {
		const { bindingId, legacy } = resolvePollBindingId(event)
		const binding = getServerCourseSyncBinding(bindingId)
		if (legacy) await logLegacyPoll(runId, 'poll', bindingId)
		async function runTypedStep<T>(
			id: string,
			operation: () => Promise<T>,
		): Promise<T> {
			const result = await step.run(id, () =>
				captureCourseSyncStepResult(operation),
			)
			return unwrapCourseSyncStepResult(
				result as unknown as CourseSyncStepResult<T>,
			)
		}

		const poll = createCourseSyncDetectionPoller({
			binding,
			readManifest: () =>
				runTypedStep('detect-course-manifest', async () => {
					const { config, missingConfig } = dropboxSyncConfigFor(binding)
					if (!config || !env.DROPBOX_REFRESH_TOKEN) {
						throw new CourseSyncError(
							'DROPBOX_SYNC_NOT_CONFIGURED',
							`Dropbox sync is not configured: ${[
								...missingConfig,
								...(!env.DROPBOX_REFRESH_TOKEN
									? ['DROPBOX_REFRESH_TOKEN']
									: []),
							].join(', ')}`,
							503,
						)
					}
					return readDropboxCourseManifest({
						config,
						refreshToken: env.DROPBOX_REFRESH_TOKEN,
					})
				}),
			getRevisionHead: (bindingId) =>
				runTypedStep('load-course-sync-revision-head', () =>
					getCourseSyncRevisionHead(bindingId),
				),
			getRun: (controlPlaneRunId) =>
				runTypedStep('load-course-sync-control-plane-run', () =>
					courseSyncControlPlane.getRun(controlPlaneRunId),
				),
			getPollState: async (bindingId) => {
				const state = await runTypedStep('load-course-sync-poll-state', () =>
					getCourseSyncPollState(bindingId),
				)
				return state ? { ...state, updatedAt: new Date(state.updatedAt) } : null
			},
			ensureBinding: async (bindingId) => {
				await runTypedStep('ensure-course-sync-binding', () =>
					courseSyncControlPlane.ensureBinding(bindingId),
				)
			},
			savePollState: async (state) => {
				await runTypedStep('save-course-sync-poll-state', () =>
					saveCourseSyncPollState({
						...state,
						updatedAt: new Date(state.updatedAt),
					}),
				)
			},
			appendLog: async (input) => {
				await runTypedStep('append-course-sync-poll-log', () =>
					appendCourseSyncPollLog({
						...input,
						occurredAt: new Date(input.occurredAt),
					}),
				)
			},
			freezeAssetBatch: (input) =>
				runTypedStep(
					`freeze-assets-batch-${String(input.batchNumber).padStart(3, '0')}`,
					() =>
						freezeCourseSyncAssetBatch(
							input,
							courseSyncControlPlane.freezeAsset,
						),
				),
			stage: (input) =>
				runTypedStep('stage-course-sync-revision', () =>
					courseSyncControlPlane.stageFrozen(input),
				),
			preview: (controlPlaneRunId) =>
				runTypedStep('preview-course-sync-revision', () =>
					courseSyncControlPlane.preview(controlPlaneRunId),
				),
			evaluateBoundedAutoApply: (controlPlaneRunId) =>
				runTypedStep('evaluate-bounded-auto-apply', () =>
					courseSyncControlPlane.evaluateBoundedAutoApply(controlPlaneRunId),
				),
			claimReviewNotification: (input) =>
				runTypedStep('claim-course-sync-review-notification', () =>
					claimCourseSyncReviewNotification(input),
				),
			completeReviewNotification: (input) =>
				runTypedStep('complete-course-sync-review-notification', () =>
					completeCourseSyncReviewNotification(input),
				),
			failReviewNotification: (input) =>
				runTypedStep('fail-course-sync-review-notification', () =>
					failCourseSyncReviewNotification(input),
				),
			apply: (input) =>
				runTypedStep('apply-course-sync-revision', () =>
					courseSyncControlPlane.apply(input),
				),
			verifyApplied: (input) =>
				runTypedStep('verify-auto-applied-course-sync-revision', () =>
					courseSyncControlPlane.verifyApplied(input),
				),
			notify: async (notification) => {
				await runTypedStep('notify-course-sync-completion', () =>
					notifyCourseSync(notification, binding.bindingId),
				)
			},
		})

		return poll(runId)
	},
)
