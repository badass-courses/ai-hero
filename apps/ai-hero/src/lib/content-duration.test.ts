import { describe, expect, it } from 'vitest'

import {
	contentDurationLabel,
	resolveContentDuration,
} from './content-duration'

describe('contentDurationLabel', () => {
	it('never substitutes transcript reading time for a missing video runtime', () => {
		expect(
			contentDurationLabel({
				isVideo: true,
				timeToReadSeconds: 60,
			}),
		).toBeUndefined()
	})

	it('uses runtime for videos and reading time for articles', () => {
		expect(
			contentDurationLabel({
				isVideo: true,
				durationSeconds: 8 * 60,
				timeToReadSeconds: 60,
			}),
		).toBe('8 min')
		expect(
			contentDurationLabel({
				isVideo: false,
				timeToReadSeconds: 3 * 60,
			}),
		).toBe('3 min read')
	})

	it('finds runtime on the joined video resource for older posts', () => {
		expect(
			resolveContentDuration(
				{ timeToRead: 60 },
				[
					{
						resource: {
							type: 'videoResource',
							fields: { duration: 8 * 60 },
						},
					},
				],
			),
		).toEqual({
			isVideo: true,
			durationSeconds: 8 * 60,
			timeToReadSeconds: 60,
		})
	})
})
