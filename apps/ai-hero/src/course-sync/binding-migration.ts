import { CourseSyncError } from './errors'
import {
	AI_HERO_COURSE_SYNC_BINDING_V2_OPERATOR,
	AI_HERO_COURSE_SYNC_BINDING_V3_UNLISTED,
	type CourseSyncBinding,
} from './types'

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
 * Resolve a stored binding without accepting drift. Only exact prior
 * server-owned literals may migrate; any other value remains immutable.
 */
export function resolveStoredCourseSyncBinding(
	stored: unknown,
	expected: CourseSyncBinding,
): {
	binding: CourseSyncBinding
	migrated: boolean
	fromContractVersion: 2 | 3 | null
} {
	if (sameBinding(stored, expected)) {
		return { binding: expected, migrated: false, fromContractVersion: null }
	}
	if (sameBinding(stored, AI_HERO_COURSE_SYNC_BINDING_V3_UNLISTED)) {
		return { binding: expected, migrated: true, fromContractVersion: 3 }
	}
	if (sameBinding(stored, AI_HERO_COURSE_SYNC_BINDING_V2_OPERATOR)) {
		return { binding: expected, migrated: true, fromContractVersion: 2 }
	}
	throw new CourseSyncError(
		'IMMUTABLE_BINDING_CONFLICT',
		'The stored sync binding does not match the server-owned v4 binding or an exact migratable prior binding.',
		409,
		{ category: 'lifecycle_conflict', retryable: false },
	)
}
