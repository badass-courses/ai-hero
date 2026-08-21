import { slackProvider } from '@/coursebuilder/slack-provider'
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
import { courseSyncControlPlane } from '@/course-sync/runtime'
import { env } from '@/env.mjs'
import {
	getDropboxSyncConfig,
	readDropboxCourseManifest,
} from '@/lib/dropbox-course-sync'

import { COURSE_SYNC_POLL_REQUESTED_EVENT } from '../events/course-sync-poll'
import { inngest } from '../inngest.server'

async function notifyCourseSync(notification: CourseSyncNotification) {
	const channel =
		env.COURSE_SYNC_SLACK_CHANNEL_ID ?? slackProvider.defaultChannelId
	if (!channel) {
		throw new CourseSyncError(
			'COURSE_SYNC_NOTIFICATION_NOT_CONFIGURED',
			'No course-sync Slack channel is configured.',
			503,
		)
	}
	await slackProvider.sendNotification({
		channel,
		...buildCourseSyncNotificationPayload(notification),
	})
}

function originalFailureRunId(event: unknown, fallback: string) {
	if (!event || typeof event !== 'object' || !('data' in event)) return fallback
	const data = (event as { data?: unknown }).data
	if (!data || typeof data !== 'object' || !('run_id' in data)) return fallback
	const runId = (data as { run_id?: unknown }).run_id
	return typeof runId === 'string' && runId ? runId : fallback
}

export const courseSyncDetectionPoller = inngest.createFunction(
	{
		id: 'ai-hero-course-sync-detection-poller',
		name: 'AI Hero Course Sync Detection Poller',
		concurrency: { limit: 1 },
		retries: 0,
		onFailure: async ({ event, step, runId }) => {
			const failedRunId = originalFailureRunId(event, runId)
			await recordCourseSyncPollFailure(
				{
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
							notifyCourseSync(notification),
						)
					},
				},
				{ runId: failedRunId, failureClass: 'POLL_RUN_KILLED' },
			)
		},
	},
	[
		{ cron: 'TZ=UTC */30 * * * *' },
		{ event: COURSE_SYNC_POLL_REQUESTED_EVENT },
	],
	async ({ step, runId }) => {
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
			readManifest: () =>
				runTypedStep('detect-course-manifest', async () => {
					const { config, missingConfig } = getDropboxSyncConfig({
						DROPBOX_APP_KEY: env.DROPBOX_APP_KEY,
						DROPBOX_APP_SECRET: env.DROPBOX_APP_SECRET,
						DROPBOX_OAUTH_REDIRECT_URI: env.DROPBOX_OAUTH_REDIRECT_URI,
						DROPBOX_SYNC_SHARED_FOLDER_ID: env.DROPBOX_SYNC_SHARED_FOLDER_ID,
						DROPBOX_SYNC_ALLOWED_ROOT: env.DROPBOX_SYNC_ALLOWED_ROOT,
						DROPBOX_SYNC_SHARED_LINK: env.DROPBOX_SYNC_SHARED_LINK,
					})
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
			freezeAsset: (input) =>
				runTypedStep(`freeze-asset-${input.sourceVideoId}`, () =>
					courseSyncControlPlane.freezeAsset(input),
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
					notifyCourseSync(notification),
				)
			},
		})

		return poll(runId)
	},
)
