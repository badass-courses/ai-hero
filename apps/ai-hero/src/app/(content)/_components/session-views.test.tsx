// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SessionExtract } from '@/lib/session-extract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	media: {
		currentTime: 0,
		play: vi.fn(() => Promise.resolve()),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	},
	writeText: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/hooks/use-mux-player', () => ({
	useMuxPlayer: () => ({ muxPlayerRef: { current: mocks.media } }),
}))
vi.mock('@/components/ai-elements/message', () => ({
	Message: ({ children }: { children: ReactNode }) => (
		<div data-message="">{children}</div>
	),
	MessageContent: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	MessageResponse: ({ children }: { children: ReactNode }) => (
		<div data-markdown="">{children}</div>
	),
}))

import { Tabs } from '@coursebuilder/ui'

import {
	SessionMomentList,
	SessionViewTabs,
	useSessionViews,
} from './session-views'

const extract: SessionExtract = {
	sessions: [
		{
			sessionId: 's1',
			entries: [
				{ kind: 'userPrompt', visibleFrom: 10, text: 'Write a failing test' },
				{
					kind: 'skillCall',
					via: 'slashCommand',
					visibleFrom: 12,
					skill: 'code-review',
					args: 'PR #34 And fix what you find.',
					skillBody: null,
				},
				{
					kind: 'skillCall',
					via: 'toolCall',
					visibleFrom: 15,
					skill: 'tdd',
					args: 'refunds',
					result: null,
					resultIsError: null,
					skillBody: null,
				},
				{
					kind: 'toolCall',
					visibleFrom: 30,
					tool: 'Bash',
					summary: 'pnpm test',
					resultIsError: true,
				},
				{ kind: 'assistantText', visibleFrom: 32, text: 'The test fails.' },
				{ kind: 'interrupt', visibleFrom: 60, text: '' },
				{ kind: 'userPrompt', visibleFrom: 70, text: 'Now make it pass' },
			],
		},
	],
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
	vi.clearAllMocks()
	mocks.media.currentTime = 0
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText: mocks.writeText },
	})
	container = document.createElement('div')
	document.body.append(container)
	root = createRoot(container)
})

afterEach(() => {
	act(() => root.unmount())
	container.remove()
})

function Views({
	tab,
	links,
}: {
	tab: 'prompts' | 'skills' | 'corrections' | 'errors'
	links?: Record<string, string>
}) {
	const views = useSessionViews(extract, links)
	return (
		<Tabs value={tab}>
			<SessionViewTabs tabs={views.tabs} />
			<SessionMomentList moments={views.byTab[tab]} />
		</Tabs>
	)
}

const render = async (node: ReactNode) => {
	await act(async () => root.render(node))
}

describe('session views', () => {
	it('offers Live and only the views this session fills', async () => {
		await render(<Views tab="prompts" />)
		const tabs = [...container.querySelectorAll('[role="tab"]')].map(
			(tab) => tab.textContent,
		)
		expect(tabs).toEqual(['Live', 'Prompts', 'Skills', 'Corrections', 'Errors'])
	})

	it('lists every prompt, marks the one the video has passed, and seeks', async () => {
		mocks.media.currentTime = 40
		await render(<Views tab="prompts" />)
		const items = [...container.querySelectorAll('li')]
		expect(
			items.map((item) => item.querySelector('[data-message]')?.textContent),
		).toEqual(['Write a failing test', 'Now make it pass'])
		expect(items[0]!.getAttribute('aria-current')).toBe('true')
		expect(items[1]!.getAttribute('aria-current')).toBeNull()

		const play = container.querySelector<HTMLButtonElement>(
			'[aria-label="Play from 1:10"]',
		)!
		await act(async () => play.click())
		expect(mocks.media.currentTime).toBe(70)
		expect(mocks.media.play).toHaveBeenCalled()
	})

	it('copies a prompt exactly as typed', async () => {
		await render(<Views tab="prompts" />)
		const copy = container.querySelector<HTMLButtonElement>(
			'[aria-label="Copy prompt"]',
		)!
		await act(async () => copy.click())
		expect(mocks.writeText).toHaveBeenCalledWith('Write a failing test')
		expect(copy.textContent).toBe('Copied')
	})

	it('links a skill to its page when it has one', async () => {
		await render(<Views tab="skills" links={{ tdd: '/skills-tdd' }} />)
		const link = container.querySelector('a')
		expect(link?.getAttribute('href')).toBe('/skills-tdd')
		expect(container.querySelectorAll('li')).toHaveLength(1)
		expect(container.textContent).toContain('Skill tdd')
		expect(container.textContent).not.toContain('refunds')
		expect(container.textContent).not.toContain('code-review')

		await render(<Views tab="skills" />)
		expect(container.querySelector('a')).toBeNull()
	})

	it('shows a correction with the prompt typed next, naming a blank one', async () => {
		await render(<Views tab="corrections" />)
		expect(container.textContent).toContain('Interrupted')
		expect(container.textContent).toContain('Next prompt')
		expect(container.querySelector('[data-message]')?.textContent).toBe(
			'Now make it pass',
		)
	})

	it('shows a failed call with the reply that came next', async () => {
		await render(<Views tab="errors" />)
		expect(container.textContent).toContain('Bash · pnpm test')
		expect(container.textContent).toContain('Next reply')
		expect(container.querySelector('[data-markdown]')?.textContent).toBe(
			'The test fails.',
		)
	})
})
