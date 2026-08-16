import type {
	CourseSyncPollLogInput,
	CourseSyncPollState,
} from './detection-poller'
import { CourseSyncError } from './errors'
import { startCourseSyncPollLifecycle } from './poll-machine'
import { AI_HERO_COURSE_SYNC_BINDING } from './types'

export type CourseSyncPollReleaseDependencies = {
	assertTarget(bindingId: string): Promise<void>
	getPollState(bindingId: string): Promise<CourseSyncPollState | null>
	savePollState(state: CourseSyncPollState): Promise<void>
	appendLog(input: CourseSyncPollLogInput): Promise<void>
}

export async function releaseCourseSyncPollHold(
	dependencies: CourseSyncPollReleaseDependencies,
	input: {
		bindingId: string
		actor: 'operator'
		reason: string
		operationId: string
		occurredAt: Date
	},
) {
	const reason = input.reason.replace(/\s+/g, ' ').trim()
	if (!reason || reason.length > 500) {
		throw new CourseSyncError(
			'RELEASE_REASON_INVALID',
			'A release reason from 1 to 500 characters is required.',
			400,
			{ category: 'lifecycle_conflict', retryable: false },
		)
	}
	await dependencies.assertTarget(input.bindingId)
	const state = await dependencies.getPollState(input.bindingId)
	if (!state) {
		throw new CourseSyncError(
			'POLL_STATE_NOT_FOUND',
			'Course sync poll state was not found.',
			404,
			{ category: 'lifecycle_conflict', retryable: false },
		)
	}
	if (state.status === 'released') return state
	if (state.status !== 'held') {
		throw new CourseSyncError(
			'POLL_STATE_NOT_HELD',
			`Course sync poll state is ${state.status}, not held.`,
			409,
			{ category: 'lifecycle_conflict', retryable: false },
		)
	}
	const lifecycle = startCourseSyncPollLifecycle({
		bindingStatus: AI_HERO_COURSE_SYNC_BINDING.status,
		pollStatus: state.status,
		strikes: state.consecutiveFailures,
		applyPolicy: AI_HERO_COURSE_SYNC_BINDING.applyPolicy,
	})
	lifecycle.send({ type: 'OPERATOR.RELEASE' })
	if (!lifecycle.getSnapshot().matches({ active: 'idle' })) {
		throw new CourseSyncError(
			'POLL_RELEASE_TRANSITION_REJECTED',
			'The poll lifecycle rejected operator release.',
			409,
			{ category: 'lifecycle_conflict', retryable: false },
		)
	}
	const released: CourseSyncPollState = {
		...state,
		status: 'released',
		consecutiveFailures: 0,
		controlPlaneRunId: null,
		failureClass: null,
		updatedAt: input.occurredAt,
	}
	await dependencies.savePollState(released)
	await dependencies.appendLog({
		bindingId: input.bindingId,
		courseVersionId: state.courseVersionId,
		providerRevision: state.providerRevision,
		runId: input.operationId,
		controlPlaneRunId: null,
		stage: 'release',
		outcome: 'succeeded',
		metadata: {
			actor: input.actor,
			reason,
			previousStatus: state.status,
			previousFailureClass: state.failureClass,
			previousControlPlaneRunId: state.controlPlaneRunId,
		},
		occurredAt: input.occurredAt,
	})
	return released
}
