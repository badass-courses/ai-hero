// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'
import { MotionGlobalConfig } from 'framer-motion'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PlayerGestureShell } from './player-gesture-shell'

vi.mock('@/utils/analytics', () => ({ track: vi.fn() }))

describe('PlayerGestureShell on touch, across a source swap', () => {
	let container: HTMLDivElement
	let root: ReturnType<typeof createRoot>
	let player: HTMLElement & { paused: boolean; ended: boolean }

	beforeEach(() => {
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
		MotionGlobalConfig.skipAnimations = true
		vi.stubGlobal('matchMedia', () => ({
			matches: true,
			addEventListener: () => {},
			removeEventListener: () => {},
		}))
		// The persistent player: one element, its source swapped under it.
		player = Object.assign(document.createElement('div'), {
			paused: true,
			ended: false,
			currentTime: 0,
			textTracks: [],
			play: () => Promise.resolve(),
			pause: () => {},
		})
		container = document.createElement('div')
		document.body.append(container)
		root = createRoot(container)
	})

	afterEach(() => {
		act(() => root.unmount())
		container.remove()
		vi.unstubAllGlobals()
	})

	function render(autoplay: boolean) {
		const playerRef = { current: player as unknown as MuxPlayerRefAttributes }
		act(() => {
			root.render(
				<PlayerGestureShell playerRef={playerRef} autoplay={autoplay}>
					<div />
				</PlayerGestureShell>,
			)
		})
	}
	const fire = (type: string, paused: boolean) =>
		act(() => {
			player.paused = paused
			player.dispatchEvent(new Event(type))
		})
	const centreShown = () =>
		container
			.querySelector('button[aria-label="Play"], button[aria-label="Pause"]')!
			.parentElement!.classList.contains('opacity-100')

	// The last lesson was paused mid-way, which raises the chrome, then
	// played to its end.
	function endLastSource() {
		fire('play', false)
		fire('pause', true)
		expect(centreShown()).toBe(true)
		fire('play', false)
		player.ended = true
		fire('pause', true)
	}

	it('raises no chrome under the end card when the video ends', () => {
		render(true)
		fire('play', false)
		player.ended = true
		fire('pause', true)
		expect(centreShown()).toBe(false)
	})

	it('shows no ▶ on the next poster while autoplay is about to start it', () => {
		render(true)
		endLastSource()
		player.ended = false
		fire('emptied', true)
		expect(centreShown()).toBe(false)
	})

	it('pins the pre-play ▶ on the next poster without autoplay', () => {
		render(false)
		endLastSource()
		player.ended = false
		fire('emptied', true)
		expect(centreShown()).toBe(true)
		expect(container.querySelector('button[aria-label="Play"]')).not.toBeNull()
	})
})
