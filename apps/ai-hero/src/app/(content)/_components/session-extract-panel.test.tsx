// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SessionExtract } from '@/lib/session-extract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	media: {
		currentTime: 0,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	},
}))

vi.mock('@/hooks/use-mux-player', () => ({
	useMuxPlayer: () => ({ muxPlayerRef: { current: mocks.media } }),
}))

import { SessionExtractStrip } from './session-extract-panel'

const extract: SessionExtract = {
	sessions: [
		{
			sessionId: 's1',
			entries: [
				{
					kind: 'userPrompt',
					visibleFrom: 10,
					text: '/code-review PR #34',
				},
				{
					kind: 'skillCall',
					via: 'slashCommand',
					visibleFrom: 10.5,
					skill: 'code-review',
					args: 'PR #34 And fix what you find.',
					skillBody: null,
				},
				{
					kind: 'skillCall',
					via: 'toolCall',
					visibleFrom: 20,
					skill: 'tdd',
					args: 'refunds',
					result: null,
					resultIsError: null,
					skillBody: null,
				},
			],
		},
	],
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
	container = document.createElement('div')
	document.body.append(container)
	root = createRoot(container)
})

afterEach(() => {
	act(() => root.unmount())
	container.remove()
})

const renderAt = async (time: number) => {
	mocks.media.currentTime = time
	await act(async () =>
		root.render(<SessionExtractStrip extract={extract} onOpen={() => {}} />),
	)
}

describe('session on screen', () => {
	it('shows the typed prompt, not the slash command skill call after it', async () => {
		await renderAt(15)
		expect(container.textContent).toContain('/code-review PR #34')
		expect(container.textContent).not.toContain('Skill')
	})

	it("names the agent's own skill call without its args", async () => {
		await renderAt(25)
		expect(container.textContent).toContain('Skill tdd')
		expect(container.textContent).not.toContain('refunds')
	})
})
