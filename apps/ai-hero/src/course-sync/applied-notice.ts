import { eq } from 'drizzle-orm'

import { courseJsonVideos } from '@ai-hero/course-sync-schema'

import { slackProvider } from '@/coursebuilder/slack-provider'
import { db } from '@/db'
import { courseSyncRun, courseSyncSourceRevision } from '@/db/schema'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'

import {
	claimCourseSyncReviewNotification,
	completeCourseSyncReviewNotification,
	failCourseSyncReviewNotification,
	getCourseSyncPlanChanges,
} from './detection-persistence'
import {
	buildCourseSyncNotificationPayload,
	COURSE_SYNC_WORKSHOP_EDIT_URL,
	type CourseSyncNotification,
	type CourseSyncSlackNotificationPayload,
} from './detection-poller'
import { CourseSyncError } from './errors'
import { COURSE_SYNC_AUTHOR_NAME, narrateCourseSyncApply } from './narrate'

export type CourseSyncAppliedNotification = Extract<
	CourseSyncNotification,
	{ kind: 'success' }
>

/**
 * Posting is one step, shared by every caller. Checking `ok` is the point: a
 * bad channel or a revoked token used to return `ok: false` and the calling
 * step still recorded success, so a silent Slack failure looked like a
 * delivered notice.
 */
export async function sendCourseSyncSlackPayload(
	payload: CourseSyncSlackNotificationPayload,
): Promise<void> {
	const channel =
		env.COURSE_SYNC_SLACK_CHANNEL_ID ?? slackProvider.defaultChannelId
	if (!channel) {
		throw new CourseSyncError(
			'COURSE_SYNC_NOTIFICATION_NOT_CONFIGURED',
			'No course-sync Slack channel is configured.',
			503,
		)
	}
	const response = await slackProvider.sendNotification({
		channel,
		...payload,
	})
	if (!response?.ok) {
		const slackError =
			(response as { error?: string } | undefined)?.error ?? 'unknown'
		throw new CourseSyncError(
			'COURSE_SYNC_NOTIFICATION_REJECTED',
			`Slack rejected the course-sync notice (${slackError}).`,
			502,
			{ category: 'transient_dependency', retryable: true },
		)
	}
}

/**
 * The applied notice is rebuilt from durable state so it does not depend on
 * who applied the run. The poller may pass the notification it already has;
 * an operator apply has nothing in memory and reads it back here.
 */
export async function buildCourseSyncAppliedNotification(
	controlPlaneRunId: string,
	pollRunId: string,
): Promise<CourseSyncAppliedNotification | null> {
	const [run] = await db
		.select()
		.from(courseSyncRun)
		.where(eq(courseSyncRun.runId, controlPlaneRunId))
		.limit(1)
	if (!run?.plan || run.state !== 'applied') return null

	const [revision] = await db
		.select()
		.from(courseSyncSourceRevision)
		.where(eq(courseSyncSourceRevision.sourceRevisionId, run.sourceRevisionId))
		.limit(1)
	if (!revision) return null

	const manifest = revision.manifest as {
		courseName?: string | null
		sections: { lessons: unknown[] }[]
	}
	const plan = run.plan

	return {
		kind: 'success',
		courseVersionId: run.courseVersionId,
		courseName: manifest.courseName ?? null,
		providerRevision: revision.providerRevision,
		manifestSha256: revision.manifestSha256,
		runId: pollRunId,
		controlPlaneRunId: run.runId,
		resourceCounts: {
			create: plan.resources.filter((item) => item.action === 'create').length,
			update: plan.resources.filter((item) => item.action === 'update').length,
			retain: plan.resources.filter((item) => item.action === 'retain').length,
		},
		structureCounts: {
			sections: manifest.sections.length,
			lessons: manifest.sections.reduce(
				(count, section) => count + section.lessons.length,
				0,
			),
			videos: courseJsonVideos(revision.manifest as never).length,
		},
		durationSeconds: Math.max(
			0,
			(run.updatedAt.getTime() - run.createdAt.getTime()) / 1000,
		),
		mediaCount: plan.media.filter((item) => item.action === 'update').length,
		workshopEditUrl: COURSE_SYNC_WORKSHOP_EDIT_URL,
	}
}

export type DeliverCourseSyncAppliedNoticeInput = {
	bindingId: string
	controlPlaneRunId: string
	pollRunId: string
	notification?: CourseSyncAppliedNotification
	planSha256?: string
	clock?: () => Date
}

export type DeliverCourseSyncAppliedNoticeResult =
	| { delivered: true }
	| { delivered: false; reason: 'not-applied' | 'already-claimed' }

export async function deliverCourseSyncAppliedNotice(
	input: DeliverCourseSyncAppliedNoticeInput,
): Promise<DeliverCourseSyncAppliedNoticeResult> {
	const clock = input.clock ?? (() => new Date())
	const notification =
		input.notification ??
		(await buildCourseSyncAppliedNotification(
			input.controlPlaneRunId,
			input.pollRunId,
		))
	if (!notification) return { delivered: false, reason: 'not-applied' }

	const planSha256 =
		input.planSha256 ??
		(await courseSyncRunPlanSha256(input.controlPlaneRunId)) ??
		notification.manifestSha256 ??
		notification.controlPlaneRunId

	const receipt = {
		kind: 'applied' as const,
		bindingId: input.bindingId,
		courseVersionId: notification.courseVersionId,
		providerRevision: notification.providerRevision,
		runId: notification.runId,
		controlPlaneRunId: notification.controlPlaneRunId,
		planSha256,
		occurredAt: clock(),
	}

	const claimed = await claimCourseSyncReviewNotification(receipt)
	if (!claimed) return { delivered: false, reason: 'already-claimed' }

	try {
		// The plan read only feeds the written summary, so a failed read degrades
		// to the deterministic line instead of costing an applied sync its notice.
		const changes = await getCourseSyncPlanChanges(
			notification.controlPlaneRunId,
		).catch(() => [])
		const narration = await narrateCourseSyncApply({
			courseName: notification.courseName,
			authorName: COURSE_SYNC_AUTHOR_NAME,
			changes,
			resourceCounts: notification.resourceCounts,
			mediaUpdated: notification.mediaCount,
			structureCounts: notification.structureCounts,
		})
		await sendCourseSyncSlackPayload(
			buildCourseSyncNotificationPayload(notification, narration),
		)
	} catch (error) {
		await failCourseSyncReviewNotification({
			...receipt,
			occurredAt: clock(),
			failureClass: 'APPLIED_NOTICE_DELIVERY_FAILED',
		})
		await log.error('course_sync.applied_notice.failed', {
			controlPlaneRunId: notification.controlPlaneRunId,
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	}

	await completeCourseSyncReviewNotification({
		...receipt,
		occurredAt: clock(),
	})
	return { delivered: true }
}

async function courseSyncRunPlanSha256(runId: string) {
	const [row] = await db
		.select({ planSha256: courseSyncRun.planSha256 })
		.from(courseSyncRun)
		.where(eq(courseSyncRun.runId, runId))
		.limit(1)
	return row?.planSha256 ?? null
}
