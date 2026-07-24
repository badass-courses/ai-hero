import { slackProvider } from '@/coursebuilder/slack-provider'
import {
	appendCourseSyncPollLog,
	getCourseSyncPollState,
	getCourseSyncRevisionHead,
	saveCourseSyncPollState,
} from '@/course-sync/detection-persistence'
import {
	buildCourseSyncNotificationPayload,
	createCourseSyncDetectionPoller,
} from '@/course-sync/detection-poller'
import { courseSyncControlPlane } from '@/course-sync/runtime'
import { CourseSyncError } from '@/course-sync/errors'
import { env } from '@/env.mjs'
import {
	getDropboxSyncConfig,
	readDropboxCourseManifest,
} from '@/lib/dropbox-course-sync'

import { inngest } from '../inngest.server'

export const courseSyncDetectionPoller = inngest.createFunction(
	{
		id: 'ai-hero-course-sync-detection-poller',
		name: 'AI Hero Course Sync Detection Poller',
		concurrency: { limit: 1 },
		retries: 0,
	},
	{ cron: 'TZ=UTC */30 * * * *' },
	async ({ step, runId }) => {
		const poll = createCourseSyncDetectionPoller({
			readManifest: () =>
				step.run('detect-course-manifest', async () => {
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
				step.run('load-course-sync-revision-head', () =>
					getCourseSyncRevisionHead(bindingId),
				),
			getPollState: async (bindingId) => {
				const state = await step.run('load-course-sync-poll-state', () =>
					getCourseSyncPollState(bindingId),
				)
				return state
					? { ...state, updatedAt: new Date(state.updatedAt) }
					: null
			},
			savePollState: async (state) => {
				await step.run('save-course-sync-poll-state', () =>
					saveCourseSyncPollState({
						...state,
						updatedAt: new Date(state.updatedAt),
					}),
				)
			},
			appendLog: async (input) => {
				await step.run('append-course-sync-poll-log', () =>
					appendCourseSyncPollLog({
						...input,
						occurredAt: new Date(input.occurredAt),
					}),
				)
			},
			stage: (input) =>
				step.run('stage-course-sync-revision', () =>
					courseSyncControlPlane.stage(input),
				),
			preview: (controlPlaneRunId) =>
				step.run('preview-course-sync-revision', () =>
					courseSyncControlPlane.preview(controlPlaneRunId),
				),
			apply: (input) =>
				step.run('apply-course-sync-revision', () =>
					courseSyncControlPlane.apply(input),
				),
			notify: async (notification) => {
				await step.run('notify-course-sync-completion', async () => {
					if (!slackProvider.defaultChannelId) {
						throw new CourseSyncError(
							'COURSE_SYNC_NOTIFICATION_NOT_CONFIGURED',
							'Slack default channel is not configured.',
							503,
						)
					}
					await slackProvider.sendNotification({
						channel: slackProvider.defaultChannelId,
						...buildCourseSyncNotificationPayload(notification),
					})
				})
			},
		})

		return poll(runId)
	},
)
