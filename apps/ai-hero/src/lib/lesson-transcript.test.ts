import { describe, expect, it } from 'vitest'

import { parseLessonVideoTranscriptRows } from './lesson-transcript'

describe('parseLessonVideoTranscriptRows', () => {
	it('treats a null transcript as normal missing optional content', () => {
		expect(parseLessonVideoTranscriptRows([{ transcript: null }])).toEqual({
			status: 'missing',
			transcript: null,
		})
	})

	it('returns an available transcript', () => {
		expect(
			parseLessonVideoTranscriptRows([{ transcript: 'Transcript text' }]),
		).toEqual({
			status: 'available',
			transcript: 'Transcript text',
		})
	})

	it('treats an empty query result as missing optional content', () => {
		expect(parseLessonVideoTranscriptRows([])).toEqual({
			status: 'missing',
			transcript: null,
		})
	})

	it('keeps malformed rows observable', () => {
		const result = parseLessonVideoTranscriptRows([{ transcript: 42 }])

		expect(result.status).toBe('invalid')
		if (result.status === 'invalid') {
			expect(result.transcript).toBeNull()
			expect(result.error.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: [0, 'transcript'],
					message: 'Expected string, received number',
				}),
			]),
		)
		}
	})
})
