// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import LazyMDXVideo from '@/components/content/lazy-mdx-video'

const { mdxImported, mdxRendered, trackedImported, trackedRendered } = vi.hoisted(() => ({
	mdxImported: vi.fn(),
	mdxRendered: vi.fn(),
	trackedImported: vi.fn(),
	trackedRendered: vi.fn(),
}))

vi.mock('@/components/content/mdx-video', () => {
	mdxImported()
	return {
		default: (props: Record<string, unknown>) => {
			mdxRendered(props)
			return <div data-testid="mdx-player" />
		},
	}
})
vi.mock('@/components/content/tracked-mux-player', () => {
	trackedImported()
	return {
		TrackedMuxPlayer: (props: Record<string, unknown>) => {
			trackedRendered(props)
			return <div data-testid="tracked-player" />
		},
	}
})

import {
	allMdxPageBuilderComponents,
	CheckList,
} from './page-builder-mdx-components'

describe('page builder video loading', () => {
	it('does not import players when the homepage uses non-video MDX helpers', () => {
		const html = renderToStaticMarkup(
			<CheckList><li>Ready</li></CheckList>,
		)
		expect(html).toContain('Ready')
		expect(LazyMDXVideo).toBeDefined()
		expect(mdxImported).not.toHaveBeenCalled()
		expect(trackedImported).not.toHaveBeenCalled()
	})

	it('loads the tracked player when an authored Mux embed mounts, preserving props', async () => {
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
		const container = document.createElement('div')
		document.body.append(container)
		const root = createRoot(container)
		const Player = allMdxPageBuilderComponents.MuxPlayer
		try {
			await act(async () => {
				root.render(
					<Player playbackId="welcome" title="Welcome" videoResourceId="video-1" />,
				)
			})
			await vi.waitFor(() => expect(trackedImported).toHaveBeenCalledTimes(1))
			await act(async () => {})
			expect(container.querySelector('[data-testid="tracked-player"]')).not.toBeNull()
			expect(trackedRendered).toHaveBeenLastCalledWith(
				expect.objectContaining({
					playbackId: 'welcome',
					title: 'Welcome',
					videoResourceId: 'video-1',
				}),
			)
			expect(mdxImported).not.toHaveBeenCalled()
		} finally {
			await act(async () => root.unmount())
			container.remove()
			vi.unstubAllGlobals()
		}
	})

	it('loads the MDX player through its client boundary only when mounted', async () => {
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
		const container = document.createElement('div')
		document.body.append(container)
		const root = createRoot(container)
		try {
			await act(async () => {
				root.render(<LazyMDXVideo resourceId="video-1" muxPlaybackId="welcome" />)
			})
			await vi.waitFor(() => expect(mdxImported).toHaveBeenCalledTimes(1))
			await act(async () => {})
			expect(container.querySelector('[data-testid="mdx-player"]')).not.toBeNull()
			expect(mdxRendered).toHaveBeenLastCalledWith(
				expect.objectContaining({ resourceId: 'video-1', muxPlaybackId: 'welcome' }),
			)
		} finally {
			await act(async () => root.unmount())
			container.remove()
			vi.unstubAllGlobals()
		}
	})
})
