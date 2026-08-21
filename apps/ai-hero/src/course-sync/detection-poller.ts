import { env } from '@/env.mjs'
import {
	courseJsonVideos,
	type CourseJsonDocumentV3,
	type CourseSyncRunSummary,
} from '@ai-hero/course-sync-schema'

import type { CourseSyncBoundedAutoApplyDecision } from './persistence-invariants'
import {
	courseSyncFreezeBatches,
	type CourseSyncFreezeBatchInput,
	type CourseSyncFreezeProgress,
	type CourseSyncFrozenAssetBatch,
} from './freeze-batches'
import type { FrozenSourceAsset } from './types'

import { CourseSyncError, asCourseSyncError } from './errors'
import {
	startCourseSyncPollLifecycle,
	type CourseSyncPollLifecycleActor,
} from './poll-machine'
import { AI_HERO_COURSE_SYNC_BINDING } from './types'

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
	| 'release'
	| 'migration'
	| 'notify'

export type CourseSyncPollState = {
	bindingId: string
	courseVersionId: string
	providerRevision: string
	status:
		| 'batching'
		| 'staging'
		| 'awaiting-apply'
		| 'applying'
		| 'succeeded'
		| 'failed'
		| 'held'
		| 'released'
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
	previousAppliedRunId?: string | null
}

export type CourseSyncManifestRead = {
	manifest: CourseJsonDocumentV3
	summary: {
		courseVersionId: string
		manifest: { rev: string; sha256: string }
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

export type CourseSyncSideEffectCount = {
	count: number
	precision: 'exact' | 'at-least' | 'unknown'
}

export type CourseSyncFailureSummary = {
	code: string
	actual: string[]
	expected: string[]
	retryable: boolean
	sideEffects: {
		sourceAssetsRead: CourseSyncSideEffectCount
		muxAssetsCreated: CourseSyncSideEffectCount
		targetWrites: 'none' | 'rolled-back' | 'unknown'
	}
	currentRunCreated: boolean
	previousAppliedRunId: string | null
}

export type CourseSyncNotification =
	| {
			kind: 'success'
			courseVersionId: string
			courseName: string | null
			providerRevision: string
			manifestSha256: string | null
			runId: string
			controlPlaneRunId: string
			resourceCounts: CourseSyncRunSummary['resourceCounts']
			structureCounts: { sections: number; lessons: number; videos: number }
			durationSeconds: number
			mediaCount: number
			workshopEditUrl: string
	  }
	| {
			kind: 'review'
			courseVersionId: string
			courseName: string | null
			providerRevision: string
			manifestSha256: string | null
			runId: string
			controlPlaneRunId: string
			resourceCounts: CourseSyncRunSummary['resourceCounts']
			mediaCount: number
			planSha256: string
			autoApplyReason: string
	  }
	| {
			kind: 'failure'
			outcome: 'failed' | 'held'
			courseVersionId: string
			courseName: string | null
			providerRevision: string
			manifestSha256: string | null
			runId: string
			controlPlaneRunId: string | null
			stage: CourseSyncPollStage
			failureClass: string
			reason: string
			summary: CourseSyncFailureSummary
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
	getRun(runId: string): Promise<CourseSyncRunSummary>
	getPollState(bindingId: string): Promise<CourseSyncPollState | null>
	ensureBinding(bindingId: string): Promise<void>
	savePollState(state: CourseSyncPollState): Promise<void>
	appendLog(input: CourseSyncPollLogInput): Promise<void>
	freezeAssetBatch(
		input: CourseSyncFreezeBatchInput,
	): Promise<CourseSyncFrozenAssetBatch>
	stage(input: {
		bindingId: string
		idempotencyKey: string
		manifest: CourseJsonDocumentV3
		providerRevision: string
		frozenAssets: ReadonlyArray<FrozenSourceAsset>
	}): Promise<CourseSyncRunSummary>
	preview(runId: string): Promise<CourseSyncRunSummary>
	evaluateBoundedAutoApply(
		runId: string,
	): Promise<CourseSyncBoundedAutoApplyDecision>
	claimReviewNotification(input: {
		bindingId: string
		courseVersionId: string
		providerRevision: string
		runId: string
		controlPlaneRunId: string
		planSha256: string
		occurredAt: Date
	}): Promise<boolean>
	completeReviewNotification(input: {
		bindingId: string
		courseVersionId: string
		providerRevision: string
		runId: string
		controlPlaneRunId: string
		planSha256: string
		occurredAt: Date
	}): Promise<void>
	failReviewNotification(input: {
		bindingId: string
		courseVersionId: string
		providerRevision: string
		runId: string
		controlPlaneRunId: string
		planSha256: string
		occurredAt: Date
		failureClass: string
	}): Promise<void>
	apply(input: {
		runId: string
		idempotencyKey: string
	}): Promise<CourseSyncRunSummary>
	verifyApplied(input: {
		runId: string
		planSha256: string
	}): Promise<CourseSyncRunSummary>
	notify(notification: CourseSyncNotification): Promise<void>
	clock?: () => Date
}

export type CourseSyncPollResult =
	| {
			outcome: 'no-op' | 'in-progress' | 'awaiting-apply'
			courseVersionId: string
			runId: string
			controlPlaneRunId?: string
	  }
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
	state: Pick<
		CourseSyncPollState,
		'courseVersionId' | 'providerRevision'
	> | null,
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

export function courseSyncFailureClass(error: unknown) {
	return error instanceof CourseSyncError
		? error.code
		: error instanceof Error
			? error.name || 'COURSE_SYNC_POLL_FAILED'
			: 'COURSE_SYNC_POLL_FAILED'
}

export function isNonRetryableCourseSyncFailure(failure: CourseSyncError) {
	return failure.retryable === false
}

function freezeProgressFromFailure(
	failure: CourseSyncError,
): CourseSyncFreezeProgress | null {
	const progress = failure.details?.freezeProgress
	if (!progress || typeof progress !== 'object') return null
	const candidate = progress as Partial<CourseSyncFreezeProgress>
	if (
		typeof candidate.sourceAssetsRead !== 'number' ||
		typeof candidate.muxAssetsCreated !== 'number' ||
		(candidate.precision !== 'exact' &&
			candidate.precision !== 'at-least' &&
			candidate.precision !== 'unknown')
	) {
		return null
	}
	return candidate as CourseSyncFreezeProgress
}

function safeFailureSummary(input: {
	failure: CourseSyncError
	code: string
	stage: CourseSyncPollStage
	controlPlaneRunId: string | null
	previousAppliedRunId: string | null
	freezeProgress?: {
		sourceAssetsRead: number
		muxAssetsCreated: number
		precision: 'exact' | 'at-least' | 'unknown'
	}
}): CourseSyncFailureSummary {
	const violations = Array.isArray(input.failure.details?.violations)
		? (input.failure.details.violations as Array<Record<string, unknown>>)
		: []
	const violationLabel = (violation: Record<string, unknown>) => {
		const target =
			violation.target && typeof violation.target === 'object'
				? (violation.target as Record<string, unknown>)
				: {}
		const targetId =
			target.id ?? target.resourceId ?? target.workshopId ?? 'unknown'
		return `${String(target.kind ?? 'target')} ${String(targetId)} ${String(violation.field)}`
	}
	const summarizeViolations = (value: 'actual' | 'expected'): string[] => {
		const summary = violations
			.slice(0, 12)
			.map(
				(violation) =>
					`${violationLabel(violation)}=${String(violation[value] ?? 'missing')}`,
			)
		if (violations.length > summary.length) {
			summary.push(`+${violations.length - summary.length} more violations`)
		}
		return summary
	}
	const actual = summarizeViolations('actual')
	const expected = summarizeViolations('expected')
	const targetFailure = input.code.startsWith('TARGET_')
	return {
		code: input.code,
		actual:
			actual.length > 0
				? actual
				: targetFailure
					? [input.failure.message]
					: ['Dependency or internal operation failed.'],
		expected:
			expected.length > 0
				? expected
				: targetFailure
					? [
							'product=self-paced/published/public',
							'workshop=workshop/published/public',
							'managed children=draft/unlisted',
						]
					: ['Operation completes within its retry policy.'],
		retryable: !isNonRetryableCourseSyncFailure(input.failure),
		sideEffects: {
			sourceAssetsRead: {
				count: input.freezeProgress?.sourceAssetsRead ?? 0,
				precision: input.freezeProgress?.precision ?? 'unknown',
			},
			muxAssetsCreated: {
				count: input.freezeProgress?.muxAssetsCreated ?? 0,
				precision: input.freezeProgress?.precision ?? 'unknown',
			},
			targetWrites: input.stage === 'apply' ? 'unknown' : 'none',
		},
		currentRunCreated: input.controlPlaneRunId !== null,
		previousAppliedRunId: input.previousAppliedRunId,
	}
}

function mediaCount(run: CourseSyncRunSummary) {
	return run.plan?.media.filter((item) => item.action === 'update').length ?? 0
}

export function shortCourseVersionId(courseVersionId: string) {
	return courseVersionId.length > 12
		? courseVersionId.slice(0, 8)
		: courseVersionId
}

export function courseSyncVersionLabel(
	courseVersionId: string,
	courseName: string | null,
) {
	const shortId = shortCourseVersionId(courseVersionId)
	return courseName ? `${courseName} (${shortId})` : shortId
}

export function courseSyncHistoryPermalink(courseVersionId: string) {
	return new URL(
		`/admin/course-sync/${encodeURIComponent(courseVersionId)}`,
		env.NEXT_PUBLIC_URL,
	).toString()
}

function compactFailureReason(reason: string) {
	const compact = reason
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[.!?]+$/, '')
	return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact
}

export function buildCourseSyncNotificationPayload(
	notification: CourseSyncNotification,
): CourseSyncSlackNotificationPayload {
	const versionLabel = courseSyncVersionLabel(
		notification.courseVersionId,
		notification.courseName,
	)
	const permalink = courseSyncHistoryPermalink(notification.courseVersionId)
	const manifestSha =
		notification.manifestSha256?.slice(0, 12) ?? 'not available'

	if (notification.kind === 'success') {
		const durationMinutes = Math.floor(notification.durationSeconds / 60)
		const text = `Synced ${versionLabel} into the bound workshop: ${notification.structureCounts.sections} sections, ${notification.structureCounts.lessons} lessons, ${notification.structureCounts.videos} videos, ${durationMinutes} min. ${permalink}`
		return {
			username: COURSE_SYNC_SLACK_USERNAME,
			icon_emoji: COURSE_SYNC_SLACK_ICON_EMOJI,
			text,
			attachments: [
				{
					fallback: text,
					color: '#2eb67d',
					title: 'AI Hero course sync applied',
					text: `<${notification.workshopEditUrl}|Open the workshop editor>`,
					fields: [
						{
							title: 'Course version',
							value: notification.courseVersionId,
							short: true,
						},
						{ title: 'Manifest SHA', value: manifestSha, short: true },
						{
							title: 'Dropbox rev',
							value: notification.providerRevision,
							short: true,
						},
						{ title: 'Poll run', value: notification.runId, short: true },
						{
							title: 'Sync run',
							value: notification.controlPlaneRunId,
							short: true,
						},
						{
							title: 'Created',
							value: String(notification.resourceCounts.create),
							short: true,
						},
						{
							title: 'Updated',
							value: String(notification.resourceCounts.update),
							short: true,
						},
						{
							title: 'Retained',
							value: String(notification.resourceCounts.retain),
							short: true,
						},
						{
							title: 'Media updated',
							value: String(notification.mediaCount),
							short: true,
						},
					],
				},
			],
		}
	}

	if (notification.kind === 'review') {
		const text = `Course sync preview ready for operator apply: ${versionLabel}. No course-content writes were made. ${permalink}`
		return {
			username: COURSE_SYNC_SLACK_USERNAME,
			icon_emoji: COURSE_SYNC_SLACK_ICON_EMOJI,
			text,
			attachments: [
				{
					fallback: text,
					color: '#f2c744',
					title: 'AI Hero course sync awaiting apply',
					text: `<${permalink}|Review the staged sync plan>`,
					fields: [
						{
							title: 'Course version',
							value: notification.courseVersionId,
							short: true,
						},
						{ title: 'Manifest SHA', value: manifestSha, short: true },
						{
							title: 'Plan SHA',
							value: notification.planSha256.slice(0, 12),
							short: true,
						},
						{
							title: 'Auto apply',
							value: notification.autoApplyReason,
							short: true,
						},
						{
							title: 'Sync run',
							value: notification.controlPlaneRunId,
							short: true,
						},
						{
							title: 'Created',
							value: String(notification.resourceCounts.create),
							short: true,
						},
						{
							title: 'Updated',
							value: String(notification.resourceCounts.update),
							short: true,
						},
						{
							title: 'Retained',
							value: String(notification.resourceCounts.retain),
							short: true,
						},
						{
							title: 'Media updated',
							value: String(notification.mediaCount),
							short: true,
						},
					],
				},
			],
		}
	}

	const reason = compactFailureReason(notification.reason)
	const held = notification.outcome === 'held'
	const disposition = held
		? notification.summary.retryable
			? 'It exhausted the retry policy and is holding for an operator.'
			: 'It is deterministic and held immediately without retry.'
		: 'The operator apply failed. It will not retry or restage automatically.'
	const text = `Course sync ${notification.outcome} while ${notification.stage} ${versionLabel}: ${reason}. ${disposition} ${permalink}`
	const sourceReads = notification.summary.sideEffects.sourceAssetsRead
	const muxCreates = notification.summary.sideEffects.muxAssetsCreated
	const sideEffects = `Source assets read: ${sourceReads.precision} ${sourceReads.count}; Mux assets created: ${muxCreates.precision} ${muxCreates.count}; target writes: ${notification.summary.sideEffects.targetWrites}`
	return {
		username: COURSE_SYNC_SLACK_USERNAME,
		icon_emoji: COURSE_SYNC_SLACK_ICON_EMOJI,
		text,
		attachments: [
			{
				fallback: text,
				color: '#d92d20',
				title: `AI Hero course sync ${notification.outcome}`,
				text: `<${permalink}|Open the sync history>`,
				fields: [
					{
						title: 'Course version',
						value: notification.courseVersionId,
						short: true,
					},
					{ title: 'Manifest SHA', value: manifestSha, short: true },
					{
						title: 'Failure class',
						value: notification.failureClass,
						short: true,
					},
					{
						title: 'Retryable',
						value: notification.summary.retryable ? 'yes' : 'no',
						short: true,
					},
					{
						title: 'Actual',
						value: notification.summary.actual.join('; '),
						short: false,
					},
					{
						title: 'Expected',
						value: notification.summary.expected.join('; '),
						short: false,
					},
					{ title: 'Side effects', value: sideEffects, short: false },
					{ title: 'Poll run', value: notification.runId, short: true },
					{
						title: 'Current sync run',
						value: notification.controlPlaneRunId ?? 'not created',
						short: true,
					},
					{
						title: 'Previous applied run',
						value: notification.summary.previousAppliedRunId ?? 'none',
						short: true,
					},
					{
						title: 'Dropbox rev',
						value: notification.providerRevision,
						short: true,
					},
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
	const bindingId = AI_HERO_COURSE_SYNC_BINDING.bindingId
	const state = await dependencies.getPollState(bindingId)
	const failureKind = input.failureClass ?? 'POLL_RUN_KILLED'
	if (state?.status === 'released') {
		await dependencies.appendLog({
			bindingId,
			courseVersionId: state.courseVersionId,
			providerRevision: state.providerRevision,
			runId: input.runId,
			controlPlaneRunId: state.controlPlaneRunId,
			stage: 'notify',
			outcome: 'skipped',
			failureClass: failureKind,
			metadata: { reason: 'operator-release-won-race' },
			occurredAt: input.occurredAt ?? new Date(),
		})
		return { held: false, consecutiveFailures: 0 }
	}
	const lifecycle = startCourseSyncPollLifecycle({
		pollStatus: state?.status ?? null,
		strikes: state?.consecutiveFailures ?? 0,
		applyPolicy: AI_HERO_COURSE_SYNC_BINDING.applyPolicy,
	})
	if (
		lifecycle.getSnapshot().matches({ active: 'idle' }) ||
		lifecycle.getSnapshot().matches({ active: 'failed' })
	) {
		lifecycle.send({ type: 'REVISION.START' })
	}
	lifecycle.send({ type: 'FAIL.RETRYABLE' })
	const strikes = lifecycle.getSnapshot().context.strikes
	const held = lifecycle.getSnapshot().matches({ active: 'held' })
	const transitionedToHeld = held && state?.status !== 'held'
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
	// Strike one always retries on its own; only page humans when the run
	// actually holds for one.
	if (transitionedToHeld) {
		await dependencies.notify({
			kind: 'failure',
			outcome: 'held',
			courseVersionId,
			courseName: null,
			providerRevision,
			manifestSha256: null,
			runId: input.runId,
			controlPlaneRunId: state?.controlPlaneRunId ?? null,
			stage: 'stage',
			failureClass: failureKind,
			reason: 'The polling run stopped before it finished',
			summary: safeFailureSummary({
				failure: new CourseSyncError(
					failureKind,
					'The polling run stopped before it finished.',
					500,
				),
				code: failureKind,
				stage: 'stage',
				controlPlaneRunId: state?.controlPlaneRunId ?? null,
				previousAppliedRunId: null,
			}),
		})
	} else {
		await dependencies.appendLog({
			bindingId,
			courseVersionId,
			providerRevision,
			runId: input.runId,
			controlPlaneRunId: state?.controlPlaneRunId ?? null,
			stage: 'notify',
			outcome: 'skipped',
			failureClass: failureKind,
			metadata: {
				reason: held ? 'already-held' : 'first-failure-will-retry',
			},
			occurredAt,
		})
	}
	return { held, consecutiveFailures: strikes }
}

export function createCourseSyncDetectionPoller(
	dependencies: CourseSyncDetectionPollerDependencies,
) {
	const clock = dependencies.clock ?? (() => new Date())
	const bindingId = AI_HERO_COURSE_SYNC_BINDING.bindingId

	const log = (base: Omit<CourseSyncPollLogInput, 'occurredAt'>) =>
		dependencies.appendLog({ ...base, occurredAt: clock() })

	return async function poll(runId: string): Promise<CourseSyncPollResult> {
		const pollStartedAt = clock()
		let courseVersionId = 'unknown'
		let courseName: string | null = null
		let providerRevision = 'unknown'
		let manifestSha256: string | null = null
		let controlPlaneRunId: string | null = null
		let previousAppliedRunId: string | null = null
		let previousState: CourseSyncPollState | null = null
		let lifecycle: CourseSyncPollLifecycleActor | null = null
		let activeStage: CourseSyncPollStage = 'detect'
		let sourceAssetsRead = 0
		let muxAssetsCreated = 0
		let freezeProgressKnown = true
		let freezeBatchInFlight = false

		const notifyReview = async (
			syncRun: CourseSyncRunSummary,
			autoApplyReason: string,
		) => {
			if (!syncRun.planSha256) {
				throw new CourseSyncError(
					'PLAN_HASH_MISSING',
					'The preview has no content-addressed plan hash.',
					409,
					{ category: 'lifecycle_conflict', retryable: false },
				)
			}
			const reviewReceipt = {
				bindingId,
				courseVersionId,
				providerRevision,
				runId,
				controlPlaneRunId: syncRun.runId,
				planSha256: syncRun.planSha256,
				occurredAt: clock(),
			}
			const claimed =
				await dependencies.claimReviewNotification(reviewReceipt)
			if (!claimed) {
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId: syncRun.runId,
					stage: 'notify',
					outcome: 'skipped',
					metadata: {
						reason: 'duplicate-review-notification',
						planSha256: syncRun.planSha256,
					},
				})
				return
			}
			try {
				await dependencies.notify({
					kind: 'review',
					courseVersionId,
					courseName,
					providerRevision,
					manifestSha256,
					runId,
					controlPlaneRunId: syncRun.runId,
					resourceCounts: syncRun.resourceCounts,
					mediaCount: mediaCount(syncRun),
					planSha256: syncRun.planSha256,
					autoApplyReason,
				})
			} catch (error) {
				const failureClass = courseSyncFailureClass(error)
				await dependencies.failReviewNotification({
					...reviewReceipt,
					occurredAt: clock(),
					failureClass,
				})
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId: syncRun.runId,
					stage: 'notify',
					outcome: 'failed',
					failureClass,
					metadata: {
						reason: 'review-notification-delivery-failed',
						planSha256: syncRun.planSha256,
					},
				})
				return
			}
			try {
				await dependencies.completeReviewNotification({
					...reviewReceipt,
					occurredAt: clock(),
				})
			} catch (error) {
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId: syncRun.runId,
					stage: 'notify',
					outcome: 'failed',
					failureClass: courseSyncFailureClass(error),
					metadata: {
						reason: 'review-notification-receipt-ambiguous',
						planSha256: syncRun.planSha256,
					},
				})
				return
			}
			await log({
				bindingId,
				courseVersionId,
				providerRevision,
				runId,
				controlPlaneRunId: syncRun.runId,
				stage: 'notify',
				outcome: 'succeeded',
				metadata: {
					reason: 'awaiting-operator-apply',
					planSha256: syncRun.planSha256,
				},
			})
		}

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
			courseName = detected.manifest.courseName
			providerRevision = detected.summary.manifest.rev
			manifestSha256 = detected.summary.manifest.sha256
			await log({
				bindingId,
				courseVersionId,
				providerRevision,
				runId,
				stage: 'detect',
				outcome: 'succeeded',
			})

			activeStage = 'compare'
			const head = await dependencies.getRevisionHead(bindingId)
			const state = await dependencies.getPollState(bindingId)
			previousState = state
			const headMatchesRevision =
				head?.courseVersionId === courseVersionId &&
				(head.providerRevision === providerRevision ||
					isLegacyAppliedHead(head, courseVersionId))
			controlPlaneRunId = headMatchesRevision ? (head?.runId ?? null) : null
			previousAppliedRunId =
				head?.previousAppliedRunId ??
				(head?.runState === 'applied' && !headMatchesRevision
					? head.runId
					: null)
			if (previousAppliedRunId === controlPlaneRunId)
				previousAppliedRunId = null
			const observedBefore = sameRevision(
				state,
				courseVersionId,
				providerRevision,
			)
			lifecycle = startCourseSyncPollLifecycle({
				pollStatus:
					state?.status === 'held'
						? 'held'
						: observedBefore
							? (state?.status ?? null)
							: null,
				strikes:
					state?.status === 'held' || observedBefore
						? (state?.consecutiveFailures ?? 0)
						: 0,
				applyPolicy:
					state?.status === 'released' || state?.status === 'awaiting-apply'
						? 'operator'
						: AI_HERO_COURSE_SYNC_BINDING.applyPolicy,
			})
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

			if (
				observedBefore &&
				(state?.status === 'awaiting-apply' || state?.status === 'applying')
			) {
				if (!state.controlPlaneRunId) {
					throw new CourseSyncError(
						'AWAITING_APPLY_RUN_MISSING',
						'The poll state has no current run to inspect.',
						409,
						{ category: 'lifecycle_conflict', retryable: false },
					)
				}
				const currentRun = await dependencies.getRun(state.controlPlaneRunId)
				controlPlaneRunId = currentRun.runId
				if (currentRun.state === 'previewed') {
					await dependencies.savePollState({
						...state,
						status: 'awaiting-apply',
						updatedAt: clock(),
					})
					await notifyReview(currentRun, 'awaiting-operator-apply')
					await log({
						bindingId,
						courseVersionId,
						providerRevision,
						runId,
						controlPlaneRunId,
						stage: 'verify',
						outcome: 'skipped',
						metadata: { reason: 'awaiting-operator-apply' },
					})
					return {
						outcome: 'awaiting-apply',
						courseVersionId,
						runId,
						controlPlaneRunId,
					}
				}
				if (currentRun.state === 'applied') {
					lifecycle.send({ type: 'APPLY.OK' })
					await dependencies.savePollState({
						...state,
						status: 'succeeded',
						consecutiveFailures: 0,
						failureClass: null,
						updatedAt: clock(),
					})
					await log({
						bindingId,
						courseVersionId,
						providerRevision,
						runId,
						controlPlaneRunId,
						stage: 'apply',
						outcome: 'succeeded',
						metadata: { source: 'operator-run-readback' },
					})
					return {
						outcome: 'no-op',
						courseVersionId,
						runId,
						controlPlaneRunId,
					}
				}
				if (currentRun.state === 'applying') {
					if (lifecycle.getSnapshot().matches({ active: 'awaitingApply' })) {
						lifecycle.send({ type: 'APPLY.START' })
					}
					await dependencies.savePollState({
						...state,
						status: 'applying',
						updatedAt: clock(),
					})
					await log({
						bindingId,
						courseVersionId,
						providerRevision,
						runId,
						controlPlaneRunId,
						stage: 'apply',
						outcome: 'started',
						metadata: { source: 'operator-run-readback' },
					})
					return {
						outcome: 'in-progress',
						courseVersionId,
						runId,
						controlPlaneRunId,
					}
				}
				if (
					currentRun.state === 'failed' ||
					currentRun.state === 'rolled_back' ||
					currentRun.state === 'superseded'
				) {
					const event =
						currentRun.state === 'failed'
							? ({ type: 'APPLY.FAILED' } as const)
							: currentRun.state === 'rolled_back'
								? ({ type: 'APPLY.ROLLED_BACK' } as const)
								: ({ type: 'APPLY.SUPERSEDED' } as const)
					lifecycle.send(event)
					const held = lifecycle.getSnapshot().matches({ active: 'held' })
					const failureClass =
						currentRun.failureCode ??
						(currentRun.state === 'failed'
							? 'OPERATOR_APPLY_FAILED'
							: currentRun.state === 'rolled_back'
								? 'APPLIED_RUN_ROLLED_BACK'
								: 'PREVIEW_SUPERSEDED')
					const failure = new CourseSyncError(
						failureClass,
						`The operator run is ${currentRun.state}.`,
						409,
						{
							category: 'lifecycle_conflict',
							retryable: false,
							details: { runState: currentRun.state },
						},
					)
					const summary = safeFailureSummary({
						failure,
						code: failureClass,
						stage: 'apply',
						controlPlaneRunId,
						previousAppliedRunId,
						freezeProgress: {
							sourceAssetsRead: 0,
							muxAssetsCreated: 0,
							precision: 'unknown',
						},
					})
					if (currentRun.state === 'rolled_back') {
						summary.sideEffects.targetWrites = 'rolled-back'
					} else if (currentRun.state === 'superseded') {
						summary.sideEffects.targetWrites = 'none'
					}
					const nextState: CourseSyncPollState = {
						...state,
						status: held ? 'held' : 'failed',
						consecutiveFailures: lifecycle.getSnapshot().context.strikes,
						failureClass,
						updatedAt: clock(),
					}
					await log({
						bindingId,
						courseVersionId,
						providerRevision,
						runId,
						controlPlaneRunId,
						stage: held ? 'hold' : 'apply',
						outcome: held ? 'held' : 'failed',
						failureClass,
						metadata: {
							source: 'operator-run-readback',
							failureSummary: summary,
						},
					})
					await dependencies.savePollState(nextState)
					await dependencies.notify({
						kind: 'failure',
						outcome: held ? 'held' : 'failed',
						courseVersionId,
						courseName,
						providerRevision,
						manifestSha256,
						runId,
						controlPlaneRunId,
						stage: 'apply',
						failureClass,
						reason: failure.message,
						summary,
					})
					return {
						outcome: held ? 'held' : 'failed',
						courseVersionId,
						runId,
						controlPlaneRunId,
						failureClass,
						consecutiveFailures: nextState.consecutiveFailures,
					}
				}
				throw new CourseSyncError(
					'AWAITING_APPLY_RUN_STATE_INVALID',
					`The awaiting run is ${currentRun.state}.`,
					409,
					{ category: 'lifecycle_conflict', retryable: false },
				)
			}

			if (
				observedBefore &&
				state?.status === 'failed' &&
				state.controlPlaneRunId
			) {
				const failedRun = await dependencies.getRun(state.controlPlaneRunId)
				if (failedRun.state === 'failed') {
					await log({
						bindingId,
						courseVersionId,
						providerRevision,
						runId,
						controlPlaneRunId: failedRun.runId,
						stage: 'apply',
						outcome: 'skipped',
						failureClass:
							failedRun.failureCode ??
							state.failureClass ??
							'OPERATOR_APPLY_FAILED',
						metadata: { reason: 'operator-apply-remains-failed' },
					})
					return {
						outcome: 'failed',
						courseVersionId,
						runId,
						controlPlaneRunId: failedRun.runId,
						failureClass:
							failedRun.failureCode ??
							state.failureClass ??
							'OPERATOR_APPLY_FAILED',
						consecutiveFailures: state.consecutiveFailures,
					}
				}
			}

			if (lifecycle.getSnapshot().matches({ active: 'held' })) {
				await dependencies.ensureBinding(bindingId)
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					stage: 'hold',
					outcome: 'held',
					failureClass: state?.failureClass,
					metadata: {
						consecutiveFailures: state?.consecutiveFailures ?? 1,
						heldCourseVersionId: state?.courseVersionId ?? null,
					},
				})
				return {
					outcome: 'held',
					courseVersionId,
					runId,
					controlPlaneRunId,
					failureClass: state?.failureClass ?? 'COURSE_SYNC_POLL_HELD',
					consecutiveFailures: state?.consecutiveFailures ?? 1,
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

			const resuming =
				observedBefore &&
				(state?.status === 'batching' || state?.status === 'staging')
			lifecycle.send({
				type: resuming ? 'REVISION.RESUME' : 'REVISION.START',
			})
			activeStage = 'stage'
			await dependencies.savePollState({
				bindingId,
				courseVersionId,
				providerRevision,
				status: 'batching',
				consecutiveFailures: retry ? 1 : 0,
				controlPlaneRunId: observedBefore
					? (state?.controlPlaneRunId ?? null)
					: null,
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
				metadata: { mode: 'resumable-batches', resuming },
			})
			const frozenAssets: FrozenSourceAsset[] = []
			const freezeBatches = courseSyncFreezeBatches(
				courseJsonVideos(detected.manifest).map((video) => video.id),
			)
			for (const [batchNumber, sourceVideoIds] of freezeBatches.entries()) {
				freezeBatchInFlight = true
				const batch = await dependencies.freezeAssetBatch({
					bindingId,
					manifest: detected.manifest,
					batchNumber,
					sourceVideoIds,
				})
				freezeBatchInFlight = false
				sourceAssetsRead += batch.progress.sourceAssetsRead
				muxAssetsCreated += batch.progress.muxAssetsCreated
				if (batch.progress.precision !== 'exact') freezeProgressKnown = false
				frozenAssets.push(...batch.assets)
			}
			lifecycle.send({ type: 'BATCHES.OK' })
			await dependencies.savePollState({
				bindingId,
				courseVersionId,
				providerRevision,
				status: 'staging',
				consecutiveFailures: retry ? 1 : 0,
				controlPlaneRunId: observedBefore
					? (state?.controlPlaneRunId ?? null)
					: null,
				failureClass: null,
				updatedAt: clock(),
			})
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

			if (syncRun.noOp && syncRun.state === 'applied') {
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
					metadata: { reason: 'stage-no-op-already-applied' },
				})
				return { outcome: 'no-op', courseVersionId, runId, controlPlaneRunId }
			}

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
				if (!syncRun.planSha256) {
					throw new CourseSyncError(
						'PLAN_HASH_MISSING',
						'The preview has no content-addressed plan hash.',
						409,
						{ category: 'lifecycle_conflict', retryable: false },
					)
				}
				const previewPlanSha256 = syncRun.planSha256
				const autoDecision =
					syncRun.state === 'previewed' &&
					AI_HERO_COURSE_SYNC_BINDING.applyPolicy === 'bounded-auto'
						? await dependencies.evaluateBoundedAutoApply(syncRun.runId)
						: null
				if (
					autoDecision &&
					autoDecision.planSha256 !== previewPlanSha256
				) {
					throw new CourseSyncError(
						'PLAN_HASH_MISMATCH',
						'The bounded-auto decision does not match the staged preview.',
						409,
						{ category: 'lifecycle_conflict', retryable: false },
					)
				}
				const boundedAutoEligible = autoDecision?.eligible === true
				lifecycle.send({
					type: 'PREVIEW.EVALUATED',
					boundedAutoEligible,
				})
				if (lifecycle.getSnapshot().matches({ active: 'awaitingApply' })) {
					await dependencies.savePollState({
						bindingId,
						courseVersionId,
						providerRevision,
						status: 'awaiting-apply',
						consecutiveFailures: 0,
						controlPlaneRunId: syncRun.runId,
						failureClass: null,
						updatedAt: clock(),
					})
					await notifyReview(
						syncRun,
						autoDecision?.eligible === false
							? autoDecision.reason
							: 'operator-policy-or-preview-state',
					)
					return {
						outcome: 'awaiting-apply',
						courseVersionId,
						runId,
						controlPlaneRunId: syncRun.runId,
					}
				}

				activeStage = 'apply'
				await dependencies.savePollState({
					bindingId,
					courseVersionId,
					providerRevision,
					status: 'applying',
					consecutiveFailures: 0,
					controlPlaneRunId: syncRun.runId,
					failureClass: null,
					updatedAt: clock(),
				})
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					stage: 'apply',
					outcome: 'started',
					metadata: {
						mode: 'bounded-auto',
						planSha256: previewPlanSha256,
					},
				})
				syncRun = await dependencies.apply({
					runId: syncRun.runId,
					idempotencyKey: `course-sync-poll-apply:${syncRun.runId}`,
				})
				syncRun = await dependencies.verifyApplied({
					runId: syncRun.runId,
					planSha256: previewPlanSha256,
				})
			}

			if (syncRun.state !== 'applied') {
				throw new CourseSyncError(
					'COURSE_SYNC_LIFECYCLE_INCOMPLETE',
					`Course sync lifecycle stopped in ${syncRun.state}.`,
					500,
				)
			}
			lifecycle.send({ type: 'APPLY.OK' })
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
				courseName,
				providerRevision,
				manifestSha256,
				runId,
				controlPlaneRunId: syncRun.runId,
				resourceCounts: syncRun.resourceCounts,
				structureCounts: {
					sections: detected.manifest.sections.length,
					lessons: detected.manifest.sections.reduce(
						(count, section) => count + section.lessons.length,
						0,
					),
					videos: courseJsonVideos(detected.manifest).length,
				},
				durationSeconds: Math.max(
					0,
					(clock().getTime() - pollStartedAt.getTime()) / 1000,
				),
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
			const kind = courseSyncFailureClass(error)
			if (kind === 'DROPBOX_SYNC_NOT_CONFIGURED') {
				// An environment without Dropbox credentials (e.g. a preview
				// deployment sharing the database) must never write the shared
				// poll state: doing so clobbers the healthy poller's record and
				// forces spurious re-stages. Log and stop, with no side effects.
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
						error: failure.message,
						reason: 'environment-not-configured-poll-state-not-saved',
					},
				})
				return {
					outcome: 'failed',
					courseVersionId,
					runId,
					controlPlaneRunId,
					failureClass: kind,
					consecutiveFailures: previousState?.consecutiveFailures ?? 0,
				}
			}
			const nonRetryable = isNonRetryableCourseSyncFailure(failure)
			lifecycle ??= startCourseSyncPollLifecycle({
				pollStatus: previousState?.status ?? null,
				strikes: previousState?.consecutiveFailures ?? 0,
				applyPolicy: AI_HERO_COURSE_SYNC_BINDING.applyPolicy,
			})
			if (
				lifecycle.getSnapshot().matches({ active: 'idle' }) ||
				lifecycle.getSnapshot().matches({ active: 'failed' })
			) {
				lifecycle.send({ type: 'REVISION.START' })
			}
			lifecycle.send({
				type: nonRetryable ? 'FAIL.NON_RETRYABLE' : 'FAIL.RETRYABLE',
			})
			const strikes = lifecycle.getSnapshot().context.strikes
			const held = lifecycle.getSnapshot().matches({ active: 'held' })
			const transitionedToHeld = held && previousState?.status !== 'held'
			const interruptedBatchProgress = freezeProgressFromFailure(failure)
			const summary = safeFailureSummary({
				failure,
				code: kind,
				stage: activeStage,
				controlPlaneRunId,
				previousAppliedRunId,
				freezeProgress: {
					sourceAssetsRead:
						sourceAssetsRead +
						(interruptedBatchProgress?.sourceAssetsRead ?? 0),
					muxAssetsCreated:
						muxAssetsCreated +
						(interruptedBatchProgress?.muxAssetsCreated ?? 0),
					precision: !freezeProgressKnown
						? 'unknown'
						: interruptedBatchProgress
							? interruptedBatchProgress.precision
							: freezeBatchInFlight
								? 'at-least'
								: 'exact',
				},
			})
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
					failureSummary: summary,
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
					metadata: {
						consecutiveFailures: strikes,
						failureSummary: summary,
					},
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
			if (transitionedToHeld) {
				try {
					await dependencies.notify({
						kind: 'failure',
						outcome: 'held',
						courseVersionId,
						courseName,
						providerRevision,
						manifestSha256,
						runId,
						controlPlaneRunId,
						stage: activeStage,
						failureClass: kind,
						reason: failure.message,
						summary,
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
						failureClass: courseSyncFailureClass(notificationError),
					})
				}
			} else {
				await log({
					bindingId,
					courseVersionId,
					providerRevision,
					runId,
					controlPlaneRunId,
					stage: 'notify',
					outcome: 'skipped',
					failureClass: kind,
					metadata: {
						reason: held ? 'already-held' : 'first-failure-will-retry',
					},
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
