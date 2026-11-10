// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractMarkdownHeadings } from '@/utils/extract-markdown-headings'

vi.mock('@/components/mdx/mdx-components', async () => {
	const React = await import('react')
	return { AISummaryContext: React.createContext(false) }
})
vi.mock('framer-motion', () => ({
	useInView: () => false,
	motion: { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6' },
}))
import { Heading } from '@/components/mdx/heading'
import { LessonBody } from './lesson-body'

let host: HTMLDivElement
let root: Root
const scroll = vi.fn()
beforeEach(() => {
	;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
	Element.prototype.scrollIntoView = scroll
	scroll.mockClear()
	window.location.hash = ''
})
afterEach(async () => {
	await act(async () => root.unmount())
	host.remove()
})
const ability = Promise.resolve({ canViewLesson: true } as any)
const content = (
	<>
		<Heading level={2}>Question</Heading>
		<Heading level={2}>Question</Heading>
		<Heading level={3}>Question</Heading>
	</>
)
function body(promise: Promise<{ content: React.ReactNode }>) {
	return (
		<React.StrictMode>
			<React.Suspense fallback={<p>Loading</p>}>
				<LessonBody
					lesson={null}
					workshop={null}
					abilityLoader={ability}
					signedIn
					mdxContentPromise={promise}
				/>
			</React.Suspense>
		</React.StrictMode>
	)
}

describe('streamed lesson body anchors', () => {
	it('gives repeated headings the same distinct ids as the TOC, across rerenders', async () => {
		const promise = Promise.resolve({ content })
		await act(async () => root.render(body(promise)))
		const toc = extractMarkdownHeadings(
			'## Question\n## Question\n### Question',
		)
		const expected = [toc[0]!.slug, toc[1]!.slug, toc[1]!.items[0]!.slug]
		expect(
			Array.from(host.querySelectorAll('h2,h3')).map((heading) => heading.id),
		).toEqual(expected)
		expect(
			Array.from(host.querySelectorAll('h2 a,h3 a')).map((link) =>
				link.getAttribute('href'),
			),
		).toEqual(expected.map((id) => `#${id}`))
		await act(async () => root.render(body(promise)))
		expect(
			Array.from(host.querySelectorAll('h2,h3')).map((heading) => heading.id),
		).toEqual(expected)
	})
	it('scrolls an initial hash only after the streamed body resolves', async () => {
		window.location.hash = '#question-1'
		let resolve!: (value: { content: React.ReactNode }) => void
		const promise = new Promise<{ content: React.ReactNode }>((done) => {
			resolve = done
		})
		await act(async () => root.render(body(promise)))
		expect(scroll).not.toHaveBeenCalled()
		await act(async () => resolve({ content }))
		expect(scroll).toHaveBeenCalled()
		expect(
			scroll.mock.instances.every((target) => target.id === 'question-1'),
		).toBe(true)
	})
	it('ignores malformed or missing hashes without throwing', async () => {
		window.location.hash = '#%E0%A4%A'
		await act(async () => root.render(body(Promise.resolve({ content }))))
		expect(scroll).not.toHaveBeenCalled()
	})
})
