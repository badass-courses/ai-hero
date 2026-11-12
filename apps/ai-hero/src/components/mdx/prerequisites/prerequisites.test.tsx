import { renderToReadableStream } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getPrerequisiteLessons: vi.fn(),
	blockProps: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	cookies: vi.fn(),
}))

vi.mock('next/headers', () => ({ cookies: mocks.cookies }))

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

const SOURCE = `<Prerequisites title="Crash Course Prerequisites">
	<Prerequisite href="https://www.aihero.dev/workshops/ai-coding-crash-course/sessions-and-the-context-241f60ee">
		What a session is, and why the review runs in a fresh one.
	</Prerequisite>
	<Prerequisite href="https://www.aihero.dev/workshops/ai-coding-crash-course/write-great-specs-with-this-skill-362ad013">
		What a spec made by \`/to-spec\` contains, so you know what the code is reviewed against.
	</Prerequisite>
</Prerequisites>
`

const lesson = (slug: string, title: string) => ({
	lessonId: `id-${slug}`,
	title,
	href: `/workshops/ai-coding-crash-course/${slug}`,
	thumbnailUrl: `/api/thumbnails?videoResourceId=video-${slug}&width=720`,
	durationSeconds: 200,
})

async function render(
	source: string,
	lessonId: string,
	prerequisitesStateCookie?: boolean,
) {
	const { content } = await compileMDX(
		source,
		{},
		{},
		{ lessonId, ...(prerequisitesStateCookie ? { prerequisitesStateCookie } : {}) },
	)
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
		expect(reasonHtml).not.toContain('<p')
	})

	it('reads the remembered state from the cookie at render on lesson pages', async () => {
		mocks.getPrerequisiteLessons.mockResolvedValue([
			lesson('sessions-and-the-context-241f60ee', 'Sessions And The Context'),
			lesson('write-great-specs-with-this-skill-362ad013', 'Write Great Specs'),
		])
		let cookie = 'other~s!host-cookie~hd'
		mocks.cookies.mockImplementation(async () => ({
			get: (name: string) =>
				name === 'ah_prereq' ? { name, value: cookie } : undefined,
		}))

		await render(SOURCE, 'host-cookie', true)
		expect(mocks.blockProps.mock.calls[0]?.[0].initialRemembered).toEqual({
			collapsed: true,
			done: true,
		})

		// Same body and context: a cached compile, read fresh per request.
		cookie = 'host-cookie~s'
		await render(SOURCE, 'host-cookie', true)
		expect(mocks.blockProps.mock.calls[1]?.[0].initialRemembered).toEqual({
			collapsed: false,
			done: false,
		})
	})

	it('never calls cookies() where the caller did not allow it (static posts)', async () => {
		mocks.getPrerequisiteLessons.mockResolvedValue([
			lesson('sessions-and-the-context-241f60ee', 'Sessions And The Context'),
			lesson('write-great-specs-with-this-skill-362ad013', 'Write Great Specs'),
		])

		await render(SOURCE, 'post-id')

		expect(mocks.cookies).not.toHaveBeenCalled()
		expect(mocks.blockProps.mock.calls[0]?.[0].initialRemembered).toBeUndefined()
	})

	it('renders the title and a list of the links when a lesson does not resolve', async () => {
		mocks.getPrerequisiteLessons.mockResolvedValue(null)

		const html = await render(SOURCE, 'host-unresolved')

		expect(mocks.blockProps).not.toHaveBeenCalled()
		expect(html).toContain('Crash Course Prerequisites')
		expect(html).toContain(
			'href="/workshops/ai-coding-crash-course/sessions-and-the-context-241f60ee"',
		)
		expect(html).toContain('What a session is, and why the review runs in a fresh one.')
		expect(mocks.warn).toHaveBeenCalledWith(
			'mdx.prerequisites.unresolved',
			expect.objectContaining({ hostLessonId: 'host-unresolved' }),
		)
	})

	it('keeps the authored URL (fragment, query) in the fallback, made relative', async () => {
		mocks.getPrerequisiteLessons.mockResolvedValue(null)

		const html = await render(
			[
				'<Prerequisites>',
				'<Prerequisite href="https://www.aihero.dev/workshops/mod/a?t=30#setup">Reason A.</Prerequisite>',
				'<Prerequisite href="/workshops/mod/b#video">Reason B.</Prerequisite>',
				'</Prerequisites>',
			].join('\n\n'),
			'host-fragment',
		)

		expect(html).toContain('href="/workshops/mod/a?t=30#setup"')
		expect(html).toContain('href="/workshops/mod/b#video"')
	})

	it('falls back without a read when a link is not a lesson URL', async () => {
		const html = await render(
			[
				'<Prerequisites>',
				'<Prerequisite href="/workshops/mod/a">Reason A.</Prerequisite>',
				'<Prerequisite href="https://example.com/elsewhere">Reason B.</Prerequisite>',
				'</Prerequisites>',
			].join('\n\n'),
			'host-bad-link',
		)

		expect(mocks.getPrerequisiteLessons).not.toHaveBeenCalled()
		expect(mocks.blockProps).not.toHaveBeenCalled()
		expect(html).toContain('>Prerequisites<')
		expect(html).toContain('https://example.com/elsewhere')
		expect(html).toContain('Reason B.')
	})

	it('renders nothing for a block with no items', async () => {
		const html = await render('<Prerequisites>\n</Prerequisites>\n', 'host-empty')

		expect(mocks.getPrerequisiteLessons).not.toHaveBeenCalled()
		expect(html).not.toContain('Prerequisites')
		expect(mocks.warn).toHaveBeenCalledWith(
			'mdx.prerequisites.empty',
			expect.objectContaining({ hostLessonId: 'host-empty' }),
		)
	})

	it('falls back the same way when the read throws', async () => {
		mocks.getPrerequisiteLessons.mockRejectedValue(new Error('db down'))

		const html = await render(SOURCE, 'host-throws')

		expect(mocks.blockProps).not.toHaveBeenCalled()
		expect(html).toContain('What a session is')
		expect(mocks.error).toHaveBeenCalledWith(
			'mdx.prerequisites.resolve.error',
			expect.objectContaining({ error: 'db down' }),
		)
	})

	it('leaves a markdown "Prerequisites" heading and list as written', async () => {
		const html = await render(
			'## Prerequisites\n\n- [A](/workshops/mod/a): Reason.\n',
			'host-markdown',
		)
		expect(mocks.getPrerequisiteLessons).not.toHaveBeenCalled()
		expect(html).toContain('<li')
	})
})
