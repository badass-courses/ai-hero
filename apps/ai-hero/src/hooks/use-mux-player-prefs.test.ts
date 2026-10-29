import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'
import { describe, expect, it, vi } from 'vitest'

import {
	handleTextTrackChange,
	keepCaptionCuesLoading,
	setPreferredPlaybackRate,
} from './use-mux-player-prefs'

describe('setPreferredPlaybackRate', () => {
	it('reapplies the saved rate after the player resets', () => {
		const player = { playbackRate: 1 } as MuxPlayerRefAttributes
		const playerRef = { current: player }

		setPreferredPlaybackRate(playerRef, 1.5)
		expect(player.playbackRate).toBe(1.5)

		player.playbackRate = 1
		setPreferredPlaybackRate(playerRef, 1.5)
		expect(player.playbackRate).toBe(1.5)
	})

	it('does nothing before the player is available', () => {
		const playerRef = { current: null }

		expect(() => setPreferredPlaybackRate(playerRef, 1.5)).not.toThrow()
	})
})

const prefs = vi.hoisted(() => ({ subtitleMode: 'hidden' as string }))
vi.mock('@/lib/mux-player-prefs', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/mux-player-prefs')>()),
	getPlayerPrefs: () => ({ subtitle: { mode: prefs.subtitleMode } }),
}))

/** A caption track whose mode changes fire `change` on its list, async. */
function fakePlayer(playbackId: string) {
	const tracks = new EventTarget() as EventTarget & {
		[index: number]: TextTrack
		length: number
	}
	let mode: TextTrackMode = 'hidden'
	const modes: TextTrackMode[] = []
	const track = {
		kind: 'subtitles',
		id: 'en',
		cues: [],
		get mode() {
			return mode
		},
		set mode(next: TextTrackMode) {
			mode = next
			modes.push(next)
			// Later than a zero-delay timer: browsers may run either first.
			setTimeout(() => tracks.dispatchEvent(new Event('change')), 2)
		},
	} as unknown as TextTrack
	tracks[0] = track
	tracks.length = 1
	const player = {
		playbackId,
		textTracks: tracks,
	} as unknown as MuxPlayerRefAttributes
	return { player, track, modes }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('keepCaptionCuesLoading', () => {
	it('shows a hidden track for one task, once per source', async () => {
		prefs.subtitleMode = 'hidden'
		const { player, track, modes } = fakePlayer('a')

		keepCaptionCuesLoading(player)
		keepCaptionCuesLoading(player)
		await settle()
		keepCaptionCuesLoading(player)
		expect(modes).toEqual(['showing', 'hidden'])
		expect(track.mode).toBe('hidden')

		Object.assign(player, { playbackId: 'b' })
		keepCaptionCuesLoading(player)
		await settle()
		expect(modes).toEqual(['showing', 'hidden', 'showing', 'hidden'])
	})

	it('hides the track only after earlier change listeners saw it showing', async () => {
		prefs.subtitleMode = 'hidden'
		const { player, track } = fakePlayer('a')
		// Stands in for playback-core, which listens from before any priming.
		const seen: TextTrackMode[] = []
		;(player.textTracks as unknown as EventTarget).addEventListener(
			'change',
			() => seen.push(track.mode),
		)

		keepCaptionCuesLoading(player)
		await settle()
		expect(seen).toEqual(['showing', 'hidden'])
	})

	it('primes a source that loaded while the previous one was priming', async () => {
		prefs.subtitleMode = 'hidden'
		const { player, modes } = fakePlayer('a')

		keepCaptionCuesLoading(player)
		Object.assign(player, { playbackId: 'b' })
		keepCaptionCuesLoading(player)
		await settle()
		expect(modes).toEqual(['showing', 'hidden', 'showing', 'hidden'])
	})

	it('leaves the track alone while the viewer has captions on', async () => {
		prefs.subtitleMode = 'showing'
		const { player, modes } = fakePlayer('a')

		const track = player.textTracks![0]!
		track.mode = 'disabled'
		modes.length = 0

		keepCaptionCuesLoading(player)
		await settle()
		expect(modes).toEqual([])
	})

	it('never saves the switch as the viewer preference', async () => {
		prefs.subtitleMode = 'hidden'
		const { player } = fakePlayer('a')
		const setPlayerPrefs = vi.fn()
		handleTextTrackChange({ current: player }, setPlayerPrefs)

		keepCaptionCuesLoading(player)
		await settle()
		expect(setPlayerPrefs).not.toHaveBeenCalled()
	})
})
