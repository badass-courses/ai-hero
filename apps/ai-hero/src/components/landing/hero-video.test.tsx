// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { playerImported, playerRendered } = vi.hoisted(() => ({
	playerImported: vi.fn(),
	playerRendered: vi.fn(),
}))

// Keep next/dynamic real: the regression is when its loader runs, not just
// whether a mocked dynamic component is visible.
vi.mock('@mux/mux-player-react', () => {
	playerImported()
	return {
		default: (props: Record<string, unknown>) => {
			playerRendered(props)
			return <div data-testid="mux-player" />
		},
	}
})

import { HeroVideo } from './hero-video'

describe('HeroVideo', () => {
	let root: Root | undefined

	afterEach(async () => {
		if (root) await act(async () => root?.unmount())
		root = undefined
		document.body.innerHTML = ''
		vi.unstubAllGlobals()
	})

	it('server-renders a thumbnail and accessible play button, not a player', () => {
		const html = renderToStaticMarkup(<HeroVideo playbackId="welcome" />)

		expect(html).toContain('Play welcome video')
		expect(html).toContain('image.mux.com')
		expect(html).toContain('thumbnail.webp')
		expect(html).not.toContain('mux-player')
		expect(playerImported).not.toHaveBeenCalled()
	})

	it('loads only on activation, preserves autoplay props, and unmounts on close', async () => {
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
		const container = document.createElement('div')
		document.body.append(container)
		root = createRoot(container)
		await act(async () => {
			root?.render(<HeroVideo playbackId="welcome" title="Welcome to AI Hero" />)
		})

		const trigger = container.querySelector('button')!
		expect(trigger.type).toBe('button')
		expect(trigger.getAttribute('aria-label')).toBe('Play Welcome to AI Hero')
		expect(container.querySelector('img')).not.toBeNull()
		expect(playerImported).not.toHaveBeenCalled()

		// Hover and focus alone must not start fetching the player.
		await act(async () => {
			trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
			trigger.focus()
		})
		expect(document.activeElement).toBe(trigger)
		expect(playerImported).not.toHaveBeenCalled()

		// A native button synthesizes this same click for Enter and Space.
		await act(async () => trigger.click())
		await vi.waitFor(() => expect(playerImported).toHaveBeenCalledTimes(1))
		await act(async () => {})
		expect(document.querySelector('[data-testid="mux-player"]')).not.toBeNull()
		const dialog = document.querySelector('[role="dialog"]')!
		const titleId = dialog.getAttribute('aria-labelledby')!
		expect(document.getElementById(titleId)?.textContent).toBe('Welcome to AI Hero')
		expect(playerRendered).toHaveBeenLastCalledWith(
			expect.objectContaining({
				playbackId: 'welcome',
				title: 'Welcome to AI Hero',
				streamType: 'on-demand',
				autoPlay: true,
				accentColor: '#ffcf77',
			}),
		)

		await act(async () => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
			)
		})
		expect(document.querySelector('[data-testid="mux-player"]')).toBeNull()
		await act(async () => trigger.click())
		expect(document.querySelector('[data-testid="mux-player"]')).not.toBeNull()
		expect(playerImported).toHaveBeenCalledTimes(1)
	})
})
