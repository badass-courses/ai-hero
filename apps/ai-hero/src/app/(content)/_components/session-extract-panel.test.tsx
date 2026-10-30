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

describe('a table in a reply', () => {
	// From Matt's "Choosing your infrastructure" session, at 4:39.
	const pricing: SessionExtract = {
		sessions: [
			{
				sessionId: 's1',
				entries: [
					{
						kind: 'assistantText',
						visibleFrom: 279,
						text: [
							'Inngest pricing, by plan:',
							'',
							'| | Free | Pro | Business |',
							'| --- | --- | --- | --- |',
							'| Price | $0 | from $99/mo | from $499/mo |',
							'| Executions | 50k/mo, then pauses | 1M, then $0.000050–$0.000015 each | 10M |',
							'| Concurrent steps | 5 | 100 | 500 |',
						].join('\n'),
					},
				],
			},
		],
	}

	it('is set like a lesson-body table, with a button that opens it in a dialog', async () => {
		mocks.media.currentTime = 300
		await act(async () =>
			root.render(<SessionExtractPanel extract={pricing} />),
		)

		// Not Streamdown's own card, toolbar and never-wrapping headers.
		expect(
			container.querySelector('[data-streamdown="table-wrapper"]'),
		).toBeNull()
		const table = container.querySelector('[data-reply] table')!
		expect(table.textContent).toContain('Concurrent steps')
		for (const cell of table.querySelectorAll('th, td')) {
			expect(cell.className).toBe('')
		}

		const view = [...container.querySelectorAll('button')].find(
			(button) => button.textContent === 'View Table',
		)
		expect(view).toBeDefined()
		await act(async () => view!.click())
		const dialog = document.querySelector('[role="dialog"]')
		expect(dialog?.querySelector('table')?.textContent).toContain(
			'$0.000050–$0.000015 each',
		)
	})
})
