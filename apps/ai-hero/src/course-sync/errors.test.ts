import { describe, expect, it } from 'vitest'

import {
	CourseSyncError,
	captureCourseSyncStepResult,
	unwrapCourseSyncStepResult,
} from './errors'

describe('course sync errors across step serialization', () => {
	it('preserves source-validation retry policy through the real JSON envelope', async () => {
		const captured = await captureCourseSyncStepResult(async () => {
			throw new CourseSyncError(
				'VIDEO_BYTE_COUNT_MISMATCH',
				'Video byte count mismatch.',
				409,
				{
					category: 'source_validation',
					retryable: false,
					details: { sourceVideoId: 'video-18', expected: 100, actual: 99 },
				},
			)
		})
		const transported = JSON.parse(JSON.stringify(captured))

		expect(() => unwrapCourseSyncStepResult(transported)).toThrowError(
			expect.objectContaining({
				code: 'VIDEO_BYTE_COUNT_MISMATCH',
				category: 'source_validation',
				retryable: false,
				details: {
					sourceVideoId: 'video-18',
					expected: 100,
					actual: 99,
				},
			}),
		)
	})

	it('preserves target violations through the real JSON envelope', async () => {
		const violations = [
			{
				target: { kind: 'workshop', id: 'workshop-1' },
				field: 'state',
				expected: 'published',
				actual: 'draft',
			},
		]
		const captured = await captureCourseSyncStepResult(async () => {
			throw new CourseSyncError(
				'TARGET_CONTRACT_MISMATCH',
				'Target contract mismatch.',
				409,
				{
					category: 'target_precondition',
					retryable: false,
					details: { violations },
				},
			)
		})
		const transported = JSON.parse(JSON.stringify(captured))

		try {
			unwrapCourseSyncStepResult(transported)
			expect.unreachable('expected transported failure')
		} catch (error) {
			expect(error).toBeInstanceOf(CourseSyncError)
			expect(error).toMatchObject({
				code: 'TARGET_CONTRACT_MISMATCH',
				category: 'target_precondition',
				retryable: false,
				details: { violations },
			})
		}
	})
})
