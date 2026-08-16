import type { CourseSyncPollState } from './detection-poller'

/**
 * Automatic poll writes run under the binding lock. A rollback hold is an
 * operator boundary and cannot be left by that path; only atomic release may
 * transition it. Older snapshots also lose to the locked durable version.
 */
export function canAutomaticallySaveCourseSyncPollState(
	current: CourseSyncPollState | null,
	next: CourseSyncPollState,
): boolean {
	if (!current) return true
	if (current.status === 'held') return false
	if (next.updatedAt.getTime() < current.updatedAt.getTime()) return false
	if (
		current.status === 'released' &&
		(next.status === 'failed' || next.status === 'held')
	) {
		return false
	}
	return true
}
