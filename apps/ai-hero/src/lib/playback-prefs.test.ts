import { describe, expect, it } from 'vitest'

import { defaultPlayerPreferences } from './mux-player-prefs'
import {
	applyPlaybackPrefToPlayerPrefs,
	parsePlaybackPrefFields,
	playbackPrefRecordFromRow,
} from './playback-prefs'

describe('parsePlaybackPrefFields', () => {
	it('defaults missing or junk fields to the 540p floor', () => {
		expect(parsePlaybackPrefFields(undefined)).toEqual({
			allowLowResolution: false,
		})
		expect(parsePlaybackPrefFields(null)).toEqual({
			allowLowResolution: false,
		})
		expect(parsePlaybackPrefFields({ allowLowResolution: 'yes' })).toEqual({
			allowLowResolution: false,
		})
	})

	it('only treats an explicit true as opt-in', () => {
		expect(parsePlaybackPrefFields({ allowLowResolution: true })).toEqual({
			allowLowResolution: true,
		})
	})
})

describe('playbackPrefRecordFromRow', () => {
	it('marks a missing row as not stored', () => {
		expect(playbackPrefRecordFromRow(undefined)).toEqual({
			allowLowResolution: false,
			stored: false,
		})
	})

	it('marks an existing row as stored', () => {
		expect(
			playbackPrefRecordFromRow({ fields: { allowLowResolution: true } }),
		).toEqual({
			allowLowResolution: true,
			stored: true,
		})
	})
})

describe('applyPlaybackPrefToPlayerPrefs', () => {
	it('overlays the durable 480p flag onto cookie player prefs', () => {
		const next = applyPlaybackPrefToPlayerPrefs(defaultPlayerPreferences, {
			allowLowResolution: true,
		})
		expect(next.allowLowResolution).toBe(true)
		expect(next.autoplay).toBe(false)
	})
})
