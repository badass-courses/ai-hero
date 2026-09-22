import { describe, expect, it } from 'vitest'

import { rankShortlinkClickCounts } from './database'

describe('shortlink performance ranking', () => {
	it('matches count-descending top-20 semantics with deterministic ties and skips deleted links', () => {
		const counts = [
			{ shortlinkId: 'deleted', clicks: 99 },
			{ shortlinkId: 'b', clicks: 10 },
			{ shortlinkId: 'a', clicks: 10 },
			{ shortlinkId: 'c', clicks: 8 },
		]

		expect(
			rankShortlinkClickCounts(counts, new Set(['a', 'b', 'c']), 20),
		).toEqual([
			{ shortlinkId: 'a', clicks: 10 },
			{ shortlinkId: 'b', clicks: 10 },
			{ shortlinkId: 'c', clicks: 8 },
		])
	})
})
