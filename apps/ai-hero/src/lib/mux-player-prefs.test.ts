import { describe, expect, it } from 'vitest'

import {
	defaultPlayerPreferences,
	muxMinResolutionForPrefs,
} from './mux-player-prefs'

describe('muxMinResolutionForPrefs', () => {
	it('keeps the 540p floor unless the viewer opts in', () => {
		expect(muxMinResolutionForPrefs(defaultPlayerPreferences)).toBe('540p')
		expect(muxMinResolutionForPrefs({ allowLowResolution: false })).toBe(
			'540p',
		)
		expect(muxMinResolutionForPrefs({})).toBe('540p')
	})

	it('unlocks 480p when the viewer opts in', () => {
		expect(muxMinResolutionForPrefs({ allowLowResolution: true })).toBe('480p')
	})
})
