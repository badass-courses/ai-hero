import { renderToReadableStream } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getPrerequisiteLessons: vi.fn(),
	blockProps: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}))

vi.mock('./prerequisites-query', () => ({
	getPrerequisiteLessons: mocks.getPrerequisiteLessons,
}))

// The client container needs tRPC; record what the server hands it instead.
vi.mock('./prerequisites-block', () => ({
	PrerequisitesBlock: (props: Record<string, unknown>) => {
		mocks.blockProps(props)
		return <div data-block="prerequisites" />
	},
}))

vi.mock('@/server/logger', () => ({
	log: { warn: mocks.warn, error: mocks.error, debug: vi.fn(), info: vi.fn() },
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(),
}))

import { compileMDX } from '@/utils/compile-mdx'

const SOURCE = `## Crash Course Prerequisites

- [Sessions And The Context](https://www.aihero.dev/workshops/ai-coding-crash-course/sessions-and-the-context-241f60ee): What a session is, and why the review runs in a fresh one.
- [Write Great Specs With This Skill](https://www.aihero.dev/workshops/ai-coding-crash-course/write-great-specs-with-this-skill-362ad013): What a spec made by \`/to-spec\` contains, so you know what the code is reviewed against.
`

const lesson = (slug: string, title: string) => ({
	lessonId: `id-${slug}`,
	title,
	href: `/workshops/ai-coding-crash-course/${slug}`,
	thumbnailUrl: `/api/thumbnails?videoResourceId=video-${slug}&width=720`,
	durationSeconds: 200,
})

async function render(source: string, lessonId: string) {
	const { content } = await compileMDX(source, {}, {}, { lessonId })
	return new Response(await renderToReadableStream(content)).text()
}

describe('Prerequisites through compileMDX', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('resolves every linked lesson in one call and hands the block its items', async () => {
		mocks.getPrerequisiteLessons.mockResolvedValue([
			lesson('sessions-and-the-context-241f60ee', 'Sessions And The Context'),
			lesson(
				'write-great-specs-with-this-skill-362ad013',
				'Write Great Specs With This Skill',
			),
		])

		const html = await render(SOURCE, 'host-resolved')

		expect(html).toContain('data-block="prerequisites"')
		expect(mocks.getPrerequisiteLessons).toHaveBeenCalledTimes(1)
		expect(mocks.getPrerequisiteLessons.mock.calls[0]?.[0]).toMatchObject([
			{
				module: 'ai-coding-crash-course',
				lesson: 'sessions-and-the-context-241f60ee',
			},
			{
				module: 'ai-coding-crash-course',
				lesson: 'write-great-specs-with-this-skill-362ad013',
			},
		])
		const props = mocks.blockProps.mock.calls[0]?.[0]
		expect(props).toMatchObject({
			title: 'Crash Course Prerequisites',
			level: 2,
			hostLessonId: 'host-resolved',
		})
		expect(props.items).toHaveLength(2)
		expect(props.items[1]).toMatchObject({
			lessonId: 'id-write-great-specs-with-this-skill-362ad013',
			title: 'Write Great Specs With This Skill',
		})
		// The reason arrives as rendered nodes, inline code included.
		const reasonHtml = await new Response(
			await renderToReadableStream(<>{props.items[1].reason}</>),
		).text()
		expect(reasonHtml).toContain('<code class="ah-code-inline">/to-spec</code>')
		expect(reasonHtml).not.toMatch(/^:/)
	})

	it('renders the authored heading and list when a lesson does not resolve', async () => {
		mocks.getPrerequisiteLessons.mockResolvedValue(null)

		const html = await render(SOURCE, 'host-unresolved')

		expect(mocks.blockProps).not.toHaveBeenCalled()
		expect(html).toContain('Crash Course Prerequisites')
		expect(html).toContain(
			'href="/workshops/ai-coding-crash-course/sessions-and-the-context-241f60ee"',
		)
		expect(html).toContain('Sessions And The Context')
		expect(html).toContain('What a session is, and why the review runs in a fresh one.')
		expect(mocks.warn).toHaveBeenCalledWith(
			'mdx.prerequisites.unresolved',
			expect.objectContaining({ hostLessonId: 'host-unresolved' }),
		)
	})

	it('falls back the same way when the read throws', async () => {
		mocks.getPrerequisiteLessons.mockRejectedValue(new Error('db down'))

		const html = await render(SOURCE, 'host-throws')

		expect(mocks.blockProps).not.toHaveBeenCalled()
		expect(html).toContain('Sessions And The Context')
		expect(mocks.error).toHaveBeenCalledWith(
			'mdx.prerequisites.resolve.error',
			expect.objectContaining({ error: 'db down' }),
		)
	})

	it('leaves a "Prerequisites" prose section untouched', async () => {
		const html = await render(
			'## Prerequisites\n\nYou should know TypeScript.\n',
			'host-prose',
		)
		expect(mocks.getPrerequisiteLessons).not.toHaveBeenCalled()
		expect(html).toContain('You should know TypeScript.')
	})
})
