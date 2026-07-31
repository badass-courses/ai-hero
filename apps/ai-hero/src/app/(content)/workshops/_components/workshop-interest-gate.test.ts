import { describe, expect, it, vi } from 'vitest'

import { syncWorkshopInterestGate } from './workshop-interest-gate'

describe('syncWorkshopInterestGate', () => {
	it('publishes the confirmed gate immediately and refreshes it in the background', () => {
		const setGate = vi.fn()
		const refreshGate = vi.fn().mockResolvedValue(undefined)
		const gate = {
			state: 'active',
			fields: {
				interest_ai_coding_crash_course: '2026-07-31',
			},
		}

		syncWorkshopInterestGate({ gate, setGate, refreshGate })

		expect(setGate).toHaveBeenCalledWith(gate)
		expect(refreshGate).toHaveBeenCalledOnce()
	})
})
