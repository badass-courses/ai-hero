// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const { mdxImported, trackedImported, trackedRendered } = vi.hoisted(() => ({
	mdxImported: vi.fn(),
	trackedImported: vi.fn(),
	trackedRendered: vi.fn(),
}))

vi.mock('@/components/content/mdx-video', () => {
	mdxImported()
	return { default: () => null }
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
})
