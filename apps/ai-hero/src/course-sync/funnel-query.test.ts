import { describe, expect, it } from 'vitest'

import {
	courseSyncFunnelLogColumns,
	courseSyncFunnelRevisionColumns,
	courseSyncFunnelRunColumns,
} from './funnel-query'

describe('course sync funnel query projections', () => {
	it('keeps large JSON columns out of sorted selects', () => {
		expect(courseSyncFunnelRevisionColumns).toEqual({
			sourceRevisionId: true,
			providerRevision: true,
			manifestSha256: true,
			stagedAt: true,
		})
		expect(courseSyncFunnelRevisionColumns).not.toHaveProperty('manifest')
		expect(courseSyncFunnelRunColumns).not.toHaveProperty('plan')
		expect(courseSyncFunnelLogColumns).toHaveProperty('metadata', true)
	})
})
