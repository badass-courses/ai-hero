import type { CourseSyncSlackNotificationPayload } from './detection-poller'
import { CourseSyncError } from './errors'

export type CourseSyncSlackThread = { channel: string; ts: string }

/** Caller serializes each run while reading, posting and saving its root. */
export async function postCourseSyncThreadNotice(input: {
	payload: CourseSyncSlackNotificationPayload
	channel: string
	root: CourseSyncSlackThread | null
	post: (
		options: CourseSyncSlackNotificationPayload & {
			channel: string
			thread_ts?: string
		},
	) => Promise<{ ok: boolean; ts?: string; channel?: string; error?: string }>
	saveRoot: (root: CourseSyncSlackThread) => Promise<void>
}): Promise<void> {
	const response = await input.post({
		...input.payload,
		channel: input.root?.channel ?? input.channel,
		...(input.root ? { thread_ts: input.root.ts } : {}),
	})
	if (!response.ok || (!input.root && !response.ts))
		throw new CourseSyncError(
			'COURSE_SYNC_NOTIFICATION_REJECTED',
			`Slack rejected the course-sync notice (${response.error ?? 'missing timestamp'}).`,
			502,
			{ category: 'transient_dependency', retryable: true },
		)
	if (!input.root)
		await input.saveRoot({
			channel: response.channel ?? input.channel,
			ts: response.ts!,
		})
}
