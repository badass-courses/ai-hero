// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SessionExtract } from '@/lib/session-extract'
import { skillKey } from '@ai-hero/learner-agent/views'
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
			play: vi.fn(() => Promise.resolve()),
			textTracks,
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

	it('shows no bar while nothing is being read out', async () => {
		mocks.media.currentTime = 25
		await act(async () =>
			root.render(<SessionExtractPanel extract={extract} />),
		)
		expect(container.querySelector('[data-spoken]')).toBeNull()
		expect(container.querySelector('[data-spoken-bar]')).toBeNull()
	})
})

describe('the whole transcript', () => {
	it('is on the page before the video reaches it, with the unreached part set back', async () => {
		mocks.media.currentTime = 0
		await act(async () =>
			root.render(<SessionExtractPanel extract={extract} />),
		)
		expect(container.textContent).toContain('/code-review PR #34')
		expect(container.textContent).toContain('Q4 - What happens')
		expect(container.querySelector('[data-reached]')).toBeNull()
	})

	it('plays from a message when the message is clicked', async () => {
		mocks.media.currentTime = 0
		await act(async () =>
			root.render(<SessionExtractPanel extract={extract} />),
		)
		const reply = container.querySelector('[data-reply]')!
		await act(async () => (reply as HTMLElement).click())
		expect(mocks.media.currentTime).toBe(18)
	})

	it('does not play from a tool call when it is clicked', async () => {
		mocks.media.currentTime = 0
		await act(async () =>
			root.render(<SessionExtractPanel extract={extract} />),
		)
		const skill = [...container.querySelectorAll('div')].find(
			(element) => element.textContent === 'Skill tdd',
		)!
		await act(async () => skill.click())
		expect(mocks.media.currentTime).toBe(0)
	})
})

describe('skill calls', () => {
	it('link to the skill page, and clicking the link does not seek', async () => {
		mocks.media.currentTime = 0
		await act(async () =>
			root.render(
				<SessionExtractPanel
					extract={extract}
					skillLinks={{ [skillKey('tdd')]: '/skills/tdd' }}
				/>,
			),
		)
		const link = container.querySelector('a[href="/skills/tdd"]')!
		expect(link.textContent).toBe('Skill page')
		link.addEventListener('click', (event) => event.preventDefault())
		await act(async () => (link as HTMLElement).click())
		expect(mocks.media.currentTime).toBe(0)
	})
})

describe('times', () => {
	it('shows a time once for rows that read the same', async () => {
		mocks.media.currentTime = 0
		await act(async () =>
			root.render(
				<SessionExtractPanel
					extract={{
						sessions: [
							{
								sessionId: 's1',
								entries: [
									{ kind: 'userPrompt', visibleFrom: 10.1, text: 'Go' },
									{ kind: 'assistantText', visibleFrom: 10.8, text: 'On it.' },
								],
							},
						],
					}}
				/>,
			),
		)
		const times = container.querySelectorAll('button[aria-label^="Play from"]')
		expect([...times].map((time) => time.textContent)).toEqual(['0:10'])
	})
})
