import {
	courseJsonVideos,
	type CourseJsonDocumentV3,
	type CourseSyncRunSummary,
} from '@ai-hero/course-sync-schema'

import type { FrozenSourceAsset } from './types'

import { CourseSyncError, asCourseSyncError } from './errors'
import { AI_HERO_DRAFT_SYNC_BINDING } from './types'

export const COURSE_SYNC_WORKSHOP_EDIT_URL =
	'https://www.aihero.dev/workshops/ai-coding-crash-course/edit'

export type CourseSyncPollStage =
	| 'detect'
	| 'compare'
	| 'stage'
	| 'verify'
	| 'apply'
	| 'retry'
	| 'hold'
	| 'notify'

export type CourseSyncPollState = {
	bindingId: string
	courseVersionId: string
	providerRevision: string
	status: 'staging' | 'succeeded' | 'failed' | 'held'
	consecutiveFailures: number
	controlPlaneRunId: string | null
	failureClass: string | null
	updatedAt: Date
}

export type CourseSyncRevisionHead = {
	courseVersionId: string
	providerRevision: string
	runId: string
	runState: CourseSyncRunSummary['state']
}

export type CourseSyncManifestRead = {
	manifest: CourseJsonDocumentV3
	summary: {
		courseVersionId: string
		manifest: { rev: string }
	}
}

export type CourseSyncPollLogInput = {
	bindingId: string
	courseVersionId: string
	providerRevision: string
	runId: string
	controlPlaneRunId?: string | null
	stage: CourseSyncPollStage
	outcome: 'started' | 'succeeded' | 'failed' | 'skipped' | 'held'
	failureClass?: string | null
	metadata?: Record<string, unknown>
	occurredAt: Date
}

export type CourseSyncNotification =
	| {
		kind: 'success'
		courseVersionId: string
		providerRevision: string
		runId: string
		controlPlaneRunId: string
		resourceCounts: CourseSyncRunSummary['resourceCounts']
		mediaCount: number
		workshopEditUrl: string
	}
	| {
		kind: 'failure'
		courseVersionId: string
		providerRevision: string
		runId: string
		controlPlaneRunId: string | null
		failureClass: string
	}

export const COURSE_SYNC_SLACK_USERNAME = 'AI Hero Course Sync'
export const COURSE_SYNC_SLACK_ICON_EMOJI = ':repeat:'

export type CourseSyncSlackNotificationPayload = {
	username: typeof COURSE_SYNC_SLACK_USERNAME
	icon_emoji: typeof COURSE_SYNC_SLACK_ICON_EMOJI
	text: string
	attachments: Array<{
		fallback: string
		color: string
		title: string
		text: string
		fields: Array<{ title: string; value: string; short: boolean }>
	}>
}

export type CourseSyncDetectionPollerDependencies = {
	readManifest(): Promise<CourseSyncManifestRead>
	getRevisionHead(bindingId: string): Promise<CourseSyncRevisionHead | null>
	getPollState(bindingId: string): Promise<CourseSyncPollState | null>
	savePollState(state: CourseSyncPollState): Promise<void>
	appendLog(input: CourseSyncPollLogInput): Promise<void>
	freezeAsset(input: {
		bindingId: string
		manifest: CourseJsonDocumentV3
		sourceVideoId: string
	}): Promise<FrozenSourceAsset>
	stage(input: {
		bindingId: string
		idempotencyKey: string
		manifest: CourseJsonDocumentV3
		providerRevision: string
		frozenAssets: ReadonlyArray<FrozenSourceAsset>
	}): Promise<CourseSyncRunSummary>
	preview(runId: string): Promise<CourseSyncRunSummary>
	apply(input: {
		runId: string
		idempotencyKey: string
	}): Promise<CourseSyncRunSummary>
	notify(notification: CourseSyncNotification): Promise<void>
	clock?: () => Date
}

export type CourseSyncPollResult =
	| { outcome: 'no-op' | 'in-progress'; courseVersionId: string; runId: string }
	| {
		outcome: 'applied'
		courseVersionId: string
		runId: string
		controlPlaneRunId: string
	}
	| {
		outcome: 'failed' | 'held'
		courseVersionId: string
		runId: string
		controlPlaneRunId: string | null
		failureClass: string
		consecutiveFailures: number
	}

function sameRevision(
	state: Pick<CourseSyncPollState, 'courseVersionId' | 'providerRevision'> | null,
	courseVersionId: string,
	providerRevision: string,
) {
	return (
		state?.courseVersionId === courseVersionId &&
		state.providerRevision === providerRevision
	)
}

function isLegacyAppliedHead(
	head: CourseSyncRevisionHead | null,
	courseVersionId: string,
) {
	return (
		head?.courseVersionId === courseVersionId &&
		head.runState === 'applied' &&
		head.providerRevision === courseVersionId
	)
}

function failureClass(error: unknown) {
	return error instanceof CourseSyncError
		? error.code
		: error instanceof Error
			? error.name || 'COURSE_SYNC_POLL_FAILED'
			: 'COURSE_SYNC_POLL_FAILED'
}

function mediaCount(run: CourseSyncRunSummary) {
	return run.plan?.media.filter((item) => item.action === 'update').length ?? 0
}

export function buildCourseSyncNotificationPayload(
	notification: CourseSyncNotification,
): CourseSyncSlackNotificationPayload {
	if (notification.kind === 'success') {
		const title = `AI Hero course sync applied ${notification.courseVersionId}`
		const fallback = `${title}: ${notification.resourceCounts.create} created, ${notification.resourceCounts.update} updated, ${notification.mediaCount} media updated.`
		return {
			username: COURSE_SYNC_SLACK_USERNAME,
			icon_emoji: COURSE_SYNC_SLACK_ICON_EMOJI,
			text: title,
			attachments: [
				{
					fallback,
					color: '#2eb67d',
					title,
					text: `<${notification.workshopEditUrl}|Open the workshop editor>`,
					fields: [
						{ title: 'Dropbox rev', value: notification.providerRevision, short: true },
						{ title: 'Run', value: notification.controlPlaneRunId, short: true },
						{ title: 'Created', value: String(notification.resourceCounts.create), short: true },
						{ title: 'Updated', value: String(notification.resourceCounts.update), short: true },
						{ title: 'Retained', value: String(notification.resourceCounts.retain), short: true },
						{ title: 'Media updated', value: String(notification.mediaCount), short: true },
					],
				},
			],
		}
	}

	const title = `AI Hero course sync failed ${notification.courseVersionId}`
	const fallback = `${title}: failure=${notification.failureClass}; poll=${notification.runId}; sync=${notification.controlPlaneRunId ?? 'not-staged'}; courseVersionId=${notification.courseVersionId}.`
	return {
		username: COURSE_SYNC_SLACK_USERNAME,
		icon_emoji: COURSE_SYNC_SLACK_ICON_EMOJI,
		text: fallback,
		attachments: [
			{
				fallback,
				color: '#d92d20',
				title,
				text: fallback,
				fields: [
					{ title: 'Failure class', value: notification.failureClass, short: true },
					{ title: 'Poll run', value: notification.runId, short: true },
					{ title: 'Sync run', value: notification.controlPlaneRunId ?? 'not staged', short: true },
					{ title: 'Dropbox rev', value: notification.providerRevision, short: true },
				],
			},
		],
	}
}

export async function recordCourseSyncPollFailure(
	dependencies: Pick<
		CourseSyncDetectionPollerDependencies,
		'getPollState' | 'savePollState' | 'appendLog' | 'notify'
	>,
	input: { runId: string; failureClass?: string; occurredAt?: Date },
) {
	const bindingId = AI_HERO_DRAFT_SYNC_BINDING.bindingId
	const state = await dependencies.getPollState(bindingId)
	const failureKind = input.failureClass ?? 'POLL_RUN_KILLED'
	const strikes = Math.min((state?.consecutiveFailures ?? 0) + 1, 2)
	const held = strikes >= 2
	const occurredAt = input.occurredAt ?? new Date()
	const courseVersionId = state?.courseVersionId ?? 'unknown'
	const providerRevision = state?.providerRevision ?? 'unknown'
	await dependencies.appendLog({
		bindingId,
		courseVersionId,
		providerRevision,
		runId: input.runId,
		controlPlaneRunId: state?.controlPlaneRunId ?? null,
		stage: 'stage',
		outcome: 'failed',
		failureClass: failureKind,
		metadata: { consecutiveFailures: strikes, source: 'inngest-on-failure' },
		occurredAt,
	})
	if (held) {
		await dependencies.appendLog({
			bindingId,
			courseVersionId,
			providerRevision,
			runId: input.runId,
			controlPlaneRunId: state?.controlPlaneRunId ?? null,
			stage: 'hold',
			outcome: 'held',
			failureClass: failureKind,
			metadata: { consecutiveFailures: strikes, source: 'inngest-on-failure' },
			occurredAt,
		})
	}
	await dependencies.savePollState({
		bindingId,
		courseVersionId,
		providerRevision,
		status: held ? 'held' : 'failed',
		consecutiveFailures: strikes,
		controlPlaneRunId: state?.controlPlaneRunId ?? null,
		failureClass: failureKind,
		updatedAt: occurredAt,
	})
	await dependencies.notify({
		kind: 'failure',
		courseVersionId,
		providerRevision,
		runId: input.runId,
		controlPlaneRunId: state?.controlPlaneRunId ?? null,
		failureClass: failureKind,
	})
	return { held, consecutiveFailures: strikes }
}

export function createCourseSyncDetectionPoller(
	dependencies: CourseSyncDetectionPollerDependencies,
) {
	const clock = dependencies.clock ?? (() => new Date())
	const bindingId = AI_HERO_DRAFT_SYNC_BINDING.bindingId

	const log = (
		base: Omit<CourseSyncPollLogInput, 'occurredAt'>,
	) => dependencies.appendLog({ ...base, occurredAt: clock() })

	return async function poll(runId: string): Promise<CourseSyncPollResult> {
		let courseVersionId = 'unknown'
		let providerRevision = 'unknown'
		let controlPlaneRunId: string | null = null
		let previousState: CourseSyncPollState | null = null
		let activeStage: CourseSyncPollStage = 'detect'

		try {
			await log({
				bindingId,
				courseVersionId,
				providerRevision,
				runId,
				stage: 'detect',
				outcome: 'started',
			})
			const detected = await dependencies.readManifest()
			courseVersionId = detected.summary.courseVersionId
			providerRevision = detected.summary.manifest.rev
			await log({
				bindingId,
				courseVersionId,
				providerRevision,
				runId,
				stage: 'detect',
				outcome: 'succeeded',
			})

			activeStage = 'compare'
			const [head, state] = await Promise.all([
				dependencies.getRevisionHead(bindingId),
				dependencies.getPollState(bindingId),
			])
			previousState = state
			controlPlaneRunId = state?.controlPlaneRunId ?? head?.runId ?? null
			const observedBefore = sameRevision(state, courseVersionId, providerRevision)
			const appliedAlready =
				(observedBefore && state?.status === 'succeeded') ||
				(head?.courseVersionId === courseVersionId &&
					head.providerRevision === providerRevision &&
					head.runState === 'applied') ||
				isLegacyAppliedHead(head, courseVersionId)
			await log({
				bindingId,
				courseVersionId,
				providerRevision,
				runId,
				controlPlaneRunId,
				stage: 'compare',
				outcome: appliedAlready ? 'skipped' : 'succeeded',
				metadata: {
					observedBefore,
					appliedAlready,
					headCourseVersionId: head?.courseVersionId ?? null,
					headProviderRevision: head?.providerRevision ?? null,
					headState: head?.runState ?? null,
					consecutiveFailures: state?.consecutiveFailures ?? 0,
				},
			})

			if (appliedAlready) {
				await dependencies.savePollState({
					bindingId,
					courseVersionId,
					providerRevision,
					status: 'succeeded',
					consecutiveFailures: 0,
					controlPlaneRunId,
					failureClass: null,
					updatedAt: clock(),
				})
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					stage: 'notify',
					outcome: 'skipped',
					metadata: { reason: 'same-revision-already-applied' },
				})
				return { outcome: 'no-op', courseVersionId, runId }
			}

			const stagingMarkerFresh =
				observedBefore &&
				state?.status === 'staging' &&
				clock().getTime() - state.updatedAt.getTime() < 2 * 60 * 60 * 1000
			if (stagingMarkerFresh) {
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					stage: 'stage',
					outcome: 'skipped',
					metadata: { reason: 'freeze-sweep-in-progress' },
				})
				return { outcome: 'in-progress', courseVersionId, runId }
			}

			if (
				observedBefore &&
				state?.status === 'held' &&
				state.consecutiveFailures >= 2
			) {
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					stage: 'hold',
					outcome: 'held',
					failureClass: state.failureClass,
					metadata: { consecutiveFailures: state.consecutiveFailures },
				})
				return {
					outcome: 'held',
					courseVersionId,
					runId,
					controlPlaneRunId,
					failureClass: state.failureClass ?? 'COURSE_SYNC_POLL_HELD',
					consecutiveFailures: state.consecutiveFailures,
				}
			}

			const retry =
				observedBefore &&
				state?.status === 'failed' &&
				state.consecutiveFailures === 1
			if (retry) {
				activeStage = 'retry'
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					stage: 'retry',
					outcome: 'started',
					metadata: { attempt: 2 },
				})
			}

			activeStage = 'stage'
			await dependencies.savePollState({
				bindingId,
				courseVersionId,
				providerRevision,
				status: 'staging',
				consecutiveFailures: retry ? 1 : 0,
				controlPlaneRunId: observedBefore ? state?.controlPlaneRunId ?? null : null,
				failureClass: null,
				updatedAt: clock(),
			})
			await log({
				bindingId,
				courseVersionId,
				providerRevision,
				runId,
				stage: 'stage',
				outcome: 'started',
			})
			const frozenAssets: FrozenSourceAsset[] = []
			for (const video of courseJsonVideos(detected.manifest)) {
				frozenAssets.push(
					await dependencies.freezeAsset({
						bindingId,
						manifest: detected.manifest,
						sourceVideoId: video.id,
					}),
				)
			}
			let syncRun = await dependencies.stage({
				bindingId,
				idempotencyKey: `course-sync-poll:${courseVersionId}:${providerRevision}`,
				manifest: detected.manifest,
				providerRevision,
				frozenAssets,
			})
			controlPlaneRunId = syncRun.runId
			await log({
				bindingId,
				courseVersionId,
				providerRevision,
				runId,
				controlPlaneRunId,
				stage: 'stage',
				outcome: 'succeeded',
				metadata: { state: syncRun.state, noOp: syncRun.noOp },
			})

			if (syncRun.state === 'staged') {
				activeStage = 'verify'
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					stage: 'verify',
					outcome: 'started',
				})
				syncRun = await dependencies.preview(syncRun.runId)
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					stage: 'verify',
					outcome: 'succeeded',
					metadata: { planSha256: syncRun.planSha256 },
				})
			}

			if (syncRun.state === 'previewed' || syncRun.state === 'failed') {
				activeStage = 'apply'
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					stage: 'apply',
					outcome: 'started',
				})
				syncRun = await dependencies.apply({
					runId: syncRun.runId,
					idempotencyKey: `course-sync-poll-apply:${syncRun.runId}`,
				})
			}

			if (syncRun.state !== 'applied') {
				throw new CourseSyncError(
					'COURSE_SYNC_LIFECYCLE_INCOMPLETE',
					`Course sync lifecycle stopped in ${syncRun.state}.`,
					500,
				)
			}
			await log({
				bindingId,
				courseVersionId,
				providerRevision,
				runId,
				controlPlaneRunId,
				stage: 'apply',
				outcome: 'succeeded',
				metadata: {
					resourceCounts: syncRun.resourceCounts,
					mediaCount: mediaCount(syncRun),
				},
			})

			activeStage = 'notify'
			await dependencies.notify({
				kind: 'success',
				courseVersionId,
				providerRevision,
				runId,
				controlPlaneRunId: syncRun.runId,
				resourceCounts: syncRun.resourceCounts,
				mediaCount: mediaCount(syncRun),
				workshopEditUrl: COURSE_SYNC_WORKSHOP_EDIT_URL,
			})
			await log({
				bindingId,
				courseVersionId,
				providerRevision,
				runId,
				controlPlaneRunId,
				stage: 'notify',
				outcome: 'succeeded',
				metadata: { channel: 'slack-default-channel' },
			})
			await dependencies.savePollState({
				bindingId,
				courseVersionId,
				providerRevision,
				status: 'succeeded',
				consecutiveFailures: 0,
				controlPlaneRunId,
				failureClass: null,
				updatedAt: clock(),
			})
			return {
				outcome: 'applied',
				courseVersionId,
				runId,
				controlPlaneRunId: syncRun.runId,
			}
		} catch (error) {
			const failure = asCourseSyncError(error)
			const kind = failureClass(error)
			const priorFailures = sameRevision(
				previousState,
				courseVersionId,
				providerRevision,
			)
				? previousState?.consecutiveFailures ?? 0
				: 0
			const strikes = Math.min(priorFailures + 1, 2)
			const held = strikes >= 2
			await log({
				bindingId,
				courseVersionId,
				providerRevision,
				runId,
				controlPlaneRunId,
				stage: activeStage,
				outcome: 'failed',
				failureClass: kind,
				metadata: {
					consecutiveFailures: strikes,
					error: failure.message,
				},
			})
			if (held) {
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					stage: 'hold',
					outcome: 'held',
					failureClass: kind,
					metadata: { consecutiveFailures: strikes },
				})
			}
			await dependencies.savePollState({
				bindingId,
				courseVersionId,
				providerRevision,
				status: held ? 'held' : 'failed',
				consecutiveFailures: strikes,
				controlPlaneRunId,
				failureClass: kind,
				updatedAt: clock(),
			})
			try {
				await dependencies.notify({
					kind: 'failure',
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					failureClass: kind,
				})
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					stage: 'notify',
					outcome: 'succeeded',
					failureClass: kind,
					metadata: { channel: 'slack-default-channel' },
				})
			} catch (notificationError) {
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					stage: 'notify',
					outcome: 'failed',
					failureClass: failureClass(notificationError),
				})
			}
			return {
				outcome: held ? 'held' : 'failed',
				courseVersionId,
				runId,
				controlPlaneRunId,
				failureClass: kind,
				consecutiveFailures: strikes,
			}
		}
	}
}
