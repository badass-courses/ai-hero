import { CourseSyncError } from './errors'
import {
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005,
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005_V5,
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005_V6,
	AI_HERO_COURSE_SYNC_BINDING_V2_OPERATOR,
	AI_HERO_COURSE_SYNC_BINDING_V3_UNLISTED,
	type CourseSyncBinding,
} from './types'

export function stableValue(value: unknown): unknown {
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
	fromContractVersion: 2 | 3 | 5 | 6 | null
} {
	if (sameBinding(stored, expected)) {
		return { binding: expected, migrated: false, fromContractVersion: null }
	}
	if (
		expected.contractVersion === 4 &&
		sameBinding(stored, AI_HERO_COURSE_SYNC_BINDING_V3_UNLISTED)
	) {
		return { binding: expected, migrated: true, fromContractVersion: 3 }
	}
	if (
		expected.contractVersion === 4 &&
		sameBinding(stored, AI_HERO_COURSE_SYNC_BINDING_V2_OPERATOR)
	) {
		return { binding: expected, migrated: true, fromContractVersion: 2 }
	}
	if (
		sameBinding(expected, AI_HERO_COURSE_SYNC_BINDING_COHORT_005) &&
		sameBinding(stored, AI_HERO_COURSE_SYNC_BINDING_COHORT_005_V5)
	) {
		return { binding: expected, migrated: true, fromContractVersion: 5 }
	}
	if (
		sameBinding(expected, AI_HERO_COURSE_SYNC_BINDING_COHORT_005) &&
		sameBinding(stored, AI_HERO_COURSE_SYNC_BINDING_COHORT_005_V6)
	) {
		return { binding: expected, migrated: true, fromContractVersion: 6 }
	}
	throw new CourseSyncError(
		'IMMUTABLE_BINDING_CONFLICT',
		'The stored sync binding does not match the server-owned binding or an exact migratable prior binding.',
		409,
		{ category: 'lifecycle_conflict', retryable: false },
	)
}
