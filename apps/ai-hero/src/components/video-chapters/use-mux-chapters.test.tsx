// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VideoChapter } from '@coursebuilder/core/schemas'

import {
	clearMuxChapters,
	replaceMuxChapters,
	useMuxChapters,
} from './use-mux-chapters'

function createTrack() {
	return { kind: 'chapters', label: 'chapters' } as TextTrack
}

describe('Mux chapter track helpers', () => {
	it('replaces existing chapters before adding new chapters', async () => {
		const previousTrack = createTrack()
		const nextTrack = createTrack()
		const chaptersTrackRef: { current: TextTrack | null } = {
			current: previousTrack,
		}
		const removeTextTrack = vi.fn()
		const addChapters = vi.fn().mockResolvedValue(nextTrack)

		const result = await replaceMuxChapters(
			{
				addChapters,
				removeTextTrack,
			} as any,
			[{ startTime: 10, title: 'Intro' }],
			chaptersTrackRef,
		)

		expect(removeTextTrack).toHaveBeenCalledWith(previousTrack)
		expect(addChapters).toHaveBeenCalledWith([
			{ startTime: 10, value: 'Intro' },
		])
		expect(result).toBe(nextTrack)
		expect(chaptersTrackRef.current).toBeNull()
	})

	it('clears an existing chapters track when chapters are empty', () => {
		const previousTrack = createTrack()
		const chaptersTrackRef: { current: TextTrack | null } = {
			current: previousTrack,
		}
		const removeTextTrack = vi.fn()

		clearMuxChapters({ removeTextTrack } as any, chaptersTrackRef)

		expect(removeTextTrack).toHaveBeenCalledWith(previousTrack)
		expect(chaptersTrackRef.current).toBeNull()
	})
})

/**
 * Stands in for `<mux-player>`: chapters are a track on the loaded source, and
 * a new source empties the element, which removes them (as Mux does on
 * `emptied`).
 */
function createPlayer(readyState: number) {
	const target = new EventTarget()
	const tracks: (TextTrack & { chapters: string[] })[] = []
	const player = {
		readyState,
		get textTracks() {
			return tracks as unknown as TextTrackList
		},
		addChapters: vi.fn(async (chapters: { value: string }[]) => {
			const track = {
				kind: 'chapters',
				label: 'chapters',
				chapters: chapters.map((c) => c.value),
			} as unknown as TextTrack & { chapters: string[] }
			tracks.push(track)
			return track
		}),
		removeTextTrack: vi.fn((track: TextTrack) => {
			const i = tracks.indexOf(track as (typeof tracks)[number])
			if (i >= 0) tracks.splice(i, 1)
		}),
		addEventListener: target.addEventListener.bind(target),
		removeEventListener: target.removeEventListener.bind(target),
		swapSource() {
			player.readyState = 0
			tracks.length = 0
		},
		loadMetadata() {
			player.readyState = 1
			target.dispatchEvent(new Event('loadedmetadata'))
		},
		chapterTitles: () => tracks.map((t) => t.chapters),
	}
	return player
}

describe('useMuxChapters', () => {
	let container: HTMLDivElement
	let root: ReturnType<typeof createRoot>

	beforeEach(() => {
		;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
		container = document.createElement('div')
		document.body.appendChild(container)
		root = createRoot(container)
	})

	afterEach(() => {
		act(() => root.unmount())
		container.remove()
	})

	function Harness({
		player,
		chapters,
	}: {
		player: ReturnType<typeof createPlayer>
		chapters: VideoChapter[]
	}) {
		const playerRef = React.useRef(player as never)
		useMuxChapters(playerRef, chapters)
		return null
	}

	async function render(
		player: ReturnType<typeof createPlayer>,
		chapters: VideoChapter[],
	) {
		await act(async () => {
			root.render(<Harness player={player} chapters={chapters} />)
		})
	}

	async function flush(fn: () => void) {
		await act(async () => fn())
	}

	it('waits for metadata when the source has not loaded yet', async () => {
		const player = createPlayer(0)
		await render(player, [{ startTime: 0, title: 'Intro' }])
		expect(player.addChapters).not.toHaveBeenCalled()

		await flush(() => player.loadMetadata())
		expect(player.chapterTitles()).toEqual([['Intro']])
	})

	it('puts the new chapters on the new source when the playback ID changes in place', async () => {
		const player = createPlayer(1)
		await render(player, [{ startTime: 0, title: 'Lesson A' }])
		expect(player.chapterTitles()).toEqual([['Lesson A']])

		// The new lesson's chapters arrive while the outgoing source still
		// reports metadata, so they land on it first.
		await render(player, [{ startTime: 0, title: 'Lesson B' }])
		expect(player.chapterTitles()).toEqual([['Lesson B']])

		// Mux empties the element for the new playback ID and drops the track.
		await flush(() => player.swapSource())
		expect(player.chapterTitles()).toEqual([])

		await flush(() => player.loadMetadata())
		expect(player.chapterTitles()).toEqual([['Lesson B']])
	})

	it('clears the chapters when the new source has none', async () => {
		const player = createPlayer(1)
		await render(player, [{ startTime: 0, title: 'Lesson A' }])

		await render(player, [])
		await flush(() => player.swapSource())
		await flush(() => player.loadMetadata())

		expect(player.chapterTitles()).toEqual([])
	})
})
