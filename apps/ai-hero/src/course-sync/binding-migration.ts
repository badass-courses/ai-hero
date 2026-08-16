import { CourseSyncError } from './errors'
import { AI_HERO_COURSE_SYNC_BINDING_V1, type CourseSyncBinding } from './types'

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, stableValue(item)]),
		)
	}
	return value
}

function sameBinding(left: unknown, right: unknown) {
	return (
		JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
	)
}

/**
 * Resolve a stored binding without accepting drift. The exact v1 server literal
 * is the sole migration source; any other value remains an immutable conflict.
 */
export function resolveStoredCourseSyncBinding(
	stored: unknown,
	expected: CourseSyncBinding,
): { binding: CourseSyncBinding; migrated: boolean } {
	if (sameBinding(stored, expected))
		return { binding: expected, migrated: false }
	if (sameBinding(stored, AI_HERO_COURSE_SYNC_BINDING_V1)) {
		return { binding: expected, migrated: true }
	}
	throw new CourseSyncError(
		'IMMUTABLE_BINDING_CONFLICT',
		'The stored sync binding does not match the server-owned v2 binding or the exact migratable v1 binding.',
		409,
		{ category: 'lifecycle_conflict', retryable: false },
	)
}
