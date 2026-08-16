import { describe, expect, it } from 'vitest'

import { courseSyncFailureClass } from './detection-poller'
import { CourseSyncError } from './errors'

describe('course sync errors across step serialization', () => {
	it('uses the typed code as Error.name so Inngest preserves it', () => {
		const original = new CourseSyncError(
			'TARGET_CONTRACT_MISMATCH',
			'Target contract mismatch.',
			409,
			{ category: 'target_precondition', retryable: false },
		)
		const serialized = JSON.parse(
			JSON.stringify({ name: original.name, message: original.message }),
		) as { name: string; message: string }
		const restored = new Error(serialized.message)
		restored.name = serialized.name
		expect(courseSyncFailureClass(restored)).toBe('TARGET_CONTRACT_MISMATCH')
	})
})
