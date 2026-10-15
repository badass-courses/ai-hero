import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	defaultPlayerPreferences,
	getPlayerPrefs,
	muxMinResolutionForPrefs,
	savePlayerPrefs,
} from './mux-player-prefs'

const jar = vi.hoisted(() => ({
	value: null as unknown,
	sticks: true,
}))
vi.mock('@coursebuilder/utils/cookies', () => ({
	default: {
		get: () => jar.value,
		set: (_: string, value: unknown) => {
			if (jar.sticks) jar.value = value
			return jar.value
		},
	},
}))

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

describe('savePlayerPrefs', () => {
	beforeEach(() => {
		vi.stubGlobal('window', {})
		jar.value = null
		jar.sticks = true
	})

	it('returns what it wrote, merged over the stored prefs', () => {
		jar.value = { ...defaultPlayerPreferences, volume: 0.5 }
		expect(savePlayerPrefs({ autoplay: true })).toMatchObject({
			volume: 0.5,
			autoplay: true,
		})
		expect(jar.value).toMatchObject({ volume: 0.5, autoplay: true })
	})

	// WebKit drops the cookie on a refused write; cookies can be blocked.
	it('keeps valid prefs when the cookie write does not stick', () => {
		jar.sticks = false
		expect(getPlayerPrefs()).toEqual(defaultPlayerPreferences)
		const prefs = savePlayerPrefs({ autoplay: true })
		expect(prefs).toEqual({ ...defaultPlayerPreferences, autoplay: true })
		expect(jar.value).toBeNull()
	})
})
