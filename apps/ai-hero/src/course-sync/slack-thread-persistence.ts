import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { courseSyncPollLog, courseSyncRun } from '@/db/schema'
import { env } from '@/env.mjs'
import type { CourseSyncSlackNotificationPayload } from './detection-poller'
import { CourseSyncError } from './errors'
import {
	postCourseSyncThreadNotice,
	type CourseSyncSlackThread,
} from './slack-thread'

export async function sendThreadedCourseSyncSlackPayload(
	payload: CourseSyncSlackNotificationPayload,
	runId: string,
	channel: string,
): Promise<void> {
	await db.transaction(async (trx) => {
		// Serialize review/live notices for one run so they cannot create two roots.
		const [run] = await trx
			.select()
			.from(courseSyncRun)
			.where(eq(courseSyncRun.runId, runId))
			.for('update')
		if (!run)
			throw new CourseSyncError('RUN_NOT_FOUND', 'Sync run not found.', 404)
		const id = `cspl_slack_thread_${runId}`
		const [stored] = await trx
			.select()
			.from(courseSyncPollLog)
			.where(eq(courseSyncPollLog.id, id))
		const root = stored?.metadata?.slackThread as
			| CourseSyncSlackThread
			| undefined
		await postCourseSyncThreadNotice({
			payload,
			channel,
			root: root ?? null,
			post: async (options) => {
				// Core's provider drops thread_ts. Use its same chat.postMessage transport and token.
				if (!env.SLACK_TOKEN)
					throw new Error('Course-sync Slack token is not configured.')
				const response = await fetch('https://slack.com/api/chat.postMessage', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${env.SLACK_TOKEN}`,
						'Content-Type': 'application/json; charset=utf-8',
					},
					body: JSON.stringify(options),
					signal: AbortSignal.timeout(5_000),
				})
				if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`)
				return response.json()
			},
			saveRoot: async (slackThread) => {
				await trx.insert(courseSyncPollLog).values({
					id,
					bindingId: run.bindingId,
					courseVersionId: run.courseVersionId,
					providerRevision: 'slack-thread',
					runId,
					controlPlaneRunId: runId,
					stage: 'notify',
					outcome: 'succeeded',
					metadata: { slackThread },
					occurredAt: new Date(),
				})
			},
		})
	})
}
