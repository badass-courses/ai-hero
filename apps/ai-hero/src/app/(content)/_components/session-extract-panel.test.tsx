// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SessionExtract } from '@/lib/session-extract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	const captions = {
		kind: 'captions',
		mode: 'hidden',
		cues: [
			{
				startTime: 30,
				endTime: 34,
				text: 'Question four is asking, what happens to the refund emails cadence already sends?',
			},
		],
	}
	const textTracks = Object.assign([captions], {
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	})
	return {
		media: {
			currentTime: 0,
			textTracks,
			play: vi.fn(() => Promise.resolve()),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		},
	}
})

vi.mock('@/hooks/use-mux-player', () => ({
	useMuxPlayer: () => ({ muxPlayerRef: { current: mocks.media } }),
}))

import {
	SessionExtractPanel,
	SessionExtractStrip,
} from './session-extract-panel'

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
					kind: 'assistantText',
					visibleFrom: 18,
					text: [
						'Q3 - Is web push in v1?: Through Knock it needs a Firebase project.',
						'Q4 - What happens to the refund emails Cadence already sends?: The "Refund approved/declined" email covers the same event.',
					].join('\n\n'),
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
				{
					kind: 'toolCall',
					visibleFrom: 40,
					tool: 'Bash',
					summary: 'pnpm test',
					resultIsError: null,
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

describe('the block Matt is reading out', () => {
	it('is marked by a bar in the gutter, with every block in one color', async () => {
		mocks.media.currentTime = 34
		await act(async () =>
			root.render(<SessionExtractPanel extract={extract} />),
		)

		const blocks = [...container.querySelectorAll('[data-reply] p')]
		expect(blocks).toHaveLength(2)
		const spoken = container.querySelector('[data-spoken]')
		expect(spoken?.textContent).toContain('refund emails')
		expect(container.querySelector('[data-spoken-bar]')).not.toBeNull()
		// Being read out changes nothing about the text itself.
		expect(blocks[0]!.className).toBe(blocks[1]!.className)
		expect(container.innerHTML).not.toMatch(/text-foreground\/55|border-image/)
	})

	it('falls back to marking the entry the video has reached', async () => {
		mocks.media.currentTime = 25
		await act(async () =>
			root.render(<SessionExtractPanel extract={extract} />),
		)
		expect(container.querySelector('[data-spoken]')).toBeNull()
		expect(container.querySelector('[data-active]')?.textContent).toContain(
			'Skill tdd',
		)
		expect(container.querySelector('[data-spoken-bar]')).not.toBeNull()
	})
})

describe('the whole transcript', () => {
	const renderPanelAt = async (time: number) => {
		mocks.media.currentTime = time
		await act(async () =>
			root.render(<SessionExtractPanel extract={extract} />),
		)
	}
	const click = async (element: Element) => {
		await act(async () =>
			element.dispatchEvent(new MouseEvent('click', { bubbles: true })),
		)
	}

	it('is listed before the video reaches any of it, with nothing marked', async () => {
		await renderPanelAt(0)
		const text = container.textContent
		expect(text).toContain('/code-review PR #34')
		expect(text).toContain('refund emails')
		expect(text).toContain('Skill tdd')
		expect(text).toContain('Bash')
		expect(container.querySelector('[data-active]')).toBeNull()
		expect(container.querySelector('[data-spoken-bar]')).toBeNull()
	})

	it('seeks to a prompt or reply when it is clicked', async () => {
		await renderPanelAt(0)
		mocks.media.play.mockClear()
		await click(
			[...container.querySelectorAll('[data-reply] p')].find((block) =>
				block.textContent?.includes('refund emails'),
			)!,
		)
		expect(mocks.media.currentTime).toBe(18)
		expect(mocks.media.play).toHaveBeenCalledTimes(1)

		const prompt = [...container.querySelectorAll('div')].find(
			(element) => element.textContent === '/code-review PR #34',
		)!
		await click(prompt)
		expect(mocks.media.currentTime).toBe(10)
	})

	it('leaves tool calls and selected text alone', async () => {
		await renderPanelAt(0)
		mocks.media.play.mockClear()
		const tool = [...container.querySelectorAll('span')].find(
			(element) => element.textContent === 'Bash',
		)!
		await click(tool)
		expect(mocks.media.currentTime).toBe(0)

		const reply = container.querySelector('[data-reply] p')!
		const selection = window.getSelection()!
		selection.selectAllChildren(reply)
		await click(reply)
		selection.removeAllRanges()
		expect(mocks.media.currentTime).toBe(0)
		expect(mocks.media.play).not.toHaveBeenCalled()
	})
})
