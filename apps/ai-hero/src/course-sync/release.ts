import type { CourseSyncPollState } from './detection-poller'
import { CourseSyncError } from './errors'
import { startCourseSyncPollLifecycle } from './poll-machine'
import { AI_HERO_COURSE_SYNC_BINDING } from './types'

export type CourseSyncPollReleaseInput = {
	bindingId: string
	actor: 'operator'
	reason: string
	operationId: string
	occurredAt: Date
}

export type CourseSyncPollReleaseDependencies = {
	releaseAtomically(
		input: CourseSyncPollReleaseInput,
	): Promise<CourseSyncPollState>
}

export function releasedCourseSyncPollState(
	state: CourseSyncPollState,
	occurredAt: Date,
): CourseSyncPollState {
	if (state.status !== 'held') {
		throw new CourseSyncError(
			'POLL_STATE_NOT_HELD',
			`Course sync poll state is ${state.status}, not held.`,
			409,
			{ category: 'lifecycle_conflict', retryable: false },
		)
	}
	const lifecycle = startCourseSyncPollLifecycle({
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
	return {
		...state,
		status: 'released',
		consecutiveFailures: 0,
		controlPlaneRunId: null,
		failureClass: null,
		updatedAt: occurredAt,
	}
}

export async function releaseCourseSyncPollHold(
	dependencies: CourseSyncPollReleaseDependencies,
	input: CourseSyncPollReleaseInput,
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
	const operationId = input.operationId.trim()
	if (!operationId || operationId.length > 255) {
		throw new CourseSyncError(
			'IDEMPOTENCY_KEY_INVALID',
			'Idempotency-Key must contain 1 to 255 characters.',
			400,
			{ category: 'lifecycle_conflict', retryable: false },
		)
	}
	return dependencies.releaseAtomically({
		...input,
		reason,
		operationId,
	})
}
