import { describe, expect, it } from 'vitest'

import { canAutomaticallySaveCourseSyncPollState } from './poll-state-guard'
import type { CourseSyncPollState } from './detection-poller'

function state(
	status: CourseSyncPollState['status'],
	updatedAt: string,
): CourseSyncPollState {
	return {
		bindingId: 'csb_ai_coding_crash_course',
		courseVersionId: 'version-1',
		providerRevision: 'dropbox-rev-1',
		status,
		consecutiveFailures: status === 'held' ? 1 : 0,
		controlPlaneRunId: 'run-1',
		failureClass: status === 'held' ? 'APPLIED_RUN_ROLLED_BACK' : null,
		applyPolicyOverride: null,
		updatedAt: new Date(updatedAt),
	}
}

describe('automatic course-sync poll-state saves', () => {
	it('never overwrites a rollback hold with stale or newer automatic state', () => {
		const rollbackHold = state('held', '2026-08-16T19:00:00.000Z')

		expect(
			canAutomaticallySaveCourseSyncPollState(
				rollbackHold,
				state('succeeded', '2026-08-16T18:59:59.000Z'),
			),
		).toBe(false)
		expect(
			canAutomaticallySaveCourseSyncPollState(
				rollbackHold,
				state('succeeded', '2026-08-16T19:00:01.000Z'),
			),
		).toBe(false)
	})

	it('reserves every transition out of held for atomic operator release', () => {
		const rollbackHold = state('held', '2026-08-16T19:00:00.000Z')
		for (const status of [
			'batching',
			'staging',
			'awaiting-apply',
			'applying',
			'succeeded',
			'failed',
			'held',
			'released',
		] satisfies CourseSyncPollState['status'][]) {
			expect(
				canAutomaticallySaveCourseSyncPollState(
					rollbackHold,
					state(status, '2026-08-16T19:00:01.000Z'),
				),
			).toBe(false)
		}
	})

	it('rejects an older automatic state version', () => {
		expect(
			canAutomaticallySaveCourseSyncPollState(
				state('awaiting-apply', '2026-08-16T19:00:00.000Z'),
				state('staging', '2026-08-16T18:59:59.000Z'),
			),
		).toBe(false)
	})
})
