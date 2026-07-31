import { parseHubSidebarBlocks } from '@/lib/hub-sidebar-parse'
import { describe, expect, it } from 'vitest'

/**
 * `parseHubSidebarBlocks` turns the CMS `hub-sidebar` page body into the nav
 * IA for BOTH the desktop sidebar and the mobile menu. Its failure mode is
 * quiet: a body it can't read yields fewer sections rather than an error, so
 * a stray edit can empty the site nav without anything going red. These pin
 * the vocabulary it must keep reading.
 */
describe('parseHubSidebarBlocks — headings', () => {
	it('reads a heading with a markdown list as a flat section', () => {
		const blocks = parseHubSidebarBlocks(
			['## Explore', '', '- [Map](/learn)', '- [Skills](/skills)'].join('\n'),
		)

		expect(blocks).toEqual([
			{
				kind: 'static',
				title: 'Explore',
				links: [
					{ label: 'Map', href: '/learn' },
					{ label: 'Skills', href: '/skills' },
				],
			},
		])
	})

	it('reads a bare heading as a category label', () => {
		const blocks = parseHubSidebarBlocks(
			'## Topics\n\n<TopicSection tag="ai" />',
		)
		expect(blocks[0]).toEqual({ kind: 'category', title: 'Topics' })
	})

	it('does not let a heading swallow a following component as its links', () => {
		const body = [
			'## Topics',
			'',
			'<TopicSection tag="evals">',
			'- [Curated](/curated)',
			'</TopicSection>',
		].join('\n')

		const blocks = parseHubSidebarBlocks(body)
		const heading = blocks.find((b) => b.kind === 'category')

		expect(heading).toEqual({ kind: 'category', title: 'Topics' })
		// The curated link belongs to the TopicSection, not to the heading.
		expect(blocks).toContainEqual({
			kind: 'topic',
			tag: 'evals',
			label: undefined,
			limit: undefined,
			curated: [{ label: 'Curated', href: '/curated' }],
		})
	})
})

describe('parseHubSidebarBlocks — components', () => {
	it('parses TopicSection attributes, including a numeric limit', () => {
		const blocks = parseHubSidebarBlocks(
			'<TopicSection tag="evals" label="Evals" limit={5}></TopicSection>',
		)

		expect(blocks[0]).toEqual({
			kind: 'topic',
			tag: 'evals',
			label: 'Evals',
			limit: 5,
			curated: [],
		})
	})

	it('parses the self-closing TopicSection form (a purely tag-fed group)', () => {
		const blocks = parseHubSidebarBlocks(
			'<TopicSection tag="evals" limit={3} />',
		)

		expect(blocks).toEqual([
			{
				kind: 'topic',
				tag: 'evals',
				label: undefined,
				limit: 3,
				curated: [],
			},
		])
	})

	it('keeps a self-closing TopicSection from swallowing the next paired one', () => {
		// Regression: the paired pattern used to match from the self-closing tag
		// all the way to the LATER block's closing tag, reporting tag "a" with
		// b's curated links and losing b entirely.
		const body = [
			'<TopicSection tag="a" />',
			'',
			'<TopicSection tag="b">',
			'- [B link](/b)',
			'</TopicSection>',
		].join('\n')

		expect(parseHubSidebarBlocks(body)).toEqual([
			{
				kind: 'topic',
				tag: 'a',
				label: undefined,
				limit: undefined,
				curated: [],
			},
			{
				kind: 'topic',
				tag: 'b',
				label: undefined,
				limit: undefined,
				curated: [{ label: 'B link', href: '/b' }],
			},
		])
	})

	it('parses SidebarLink children alongside markdown links', () => {
		const blocks = parseHubSidebarBlocks(
			[
				'<SidebarSection title="Guides">',
				'- [Markdown](/md)',
				'<SidebarLink href="/jsx">JSX</SidebarLink>',
				'</SidebarSection>',
			].join('\n'),
		)

		expect(blocks[0]).toMatchObject({
			kind: 'static',
			title: 'Guides',
			links: [
				{ label: 'Markdown', href: '/md' },
				{ label: 'JSX', href: '/jsx' },
			],
		})
	})

	it('keeps interleaved markdown and SidebarLink children in document order', () => {
		const blocks = parseHubSidebarBlocks(
			[
				'<SidebarSection title="Guides">',
				'<SidebarLink href="/first">First</SidebarLink>',
				'- [Second](/second)',
				'<SidebarLink href="/third">Third</SidebarLink>',
				'- [Fourth](/fourth)',
				'</SidebarSection>',
			].join('\n'),
		)

		expect(blocks[0]).toMatchObject({
			kind: 'static',
			links: [
				{ label: 'First', href: '/first' },
				{ label: 'Second', href: '/second' },
				{ label: 'Third', href: '/third' },
				{ label: 'Fourth', href: '/fourth' },
			],
		})
	})

	it('defaults the titles of the two self-closing components', () => {
		const blocks = parseHubSidebarBlocks('<WhatsNew />\n\n<SkillsNav />')
		expect(blocks).toEqual([
			{ kind: 'whatsNew', title: "What's New" },
			{ kind: 'skillsNav', title: 'Skills' },
		])
	})

	it('honours an explicit title on those components', () => {
		const blocks = parseHubSidebarBlocks('<WhatsNew title="Fresh" />')
		expect(blocks[0]).toEqual({ kind: 'whatsNew', title: 'Fresh' })
	})
})

describe('parseHubSidebarBlocks — resilience', () => {
	it('preserves document order across mixed block kinds', () => {
		const body = [
			'## Explore',
			'- [Map](/learn)',
			'',
			'<WhatsNew />',
			'',
			'## Topics',
			'',
			'<TopicSection tag="evals" />',
			'',
			'<SkillsNav />',
		].join('\n')

		expect(parseHubSidebarBlocks(body).map((b) => b.kind)).toEqual([
			'static',
			'whatsNew',
			'category',
			'topic',
			'skillsNav',
		])
	})

	it('strips MDX comments so authoring examples are not parsed as real blocks', () => {
		const body = [
			'{/* Example: <SidebarSection title="Sample">',
			'- [Not real](/nope)',
			'</SidebarSection> */}',
			'',
			'## Explore',
			'- [Map](/learn)',
		].join('\n')

		const blocks = parseHubSidebarBlocks(body)
		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toMatchObject({ title: 'Explore' })
	})

	it('skips unrecognized content instead of throwing', () => {
		expect(() => parseHubSidebarBlocks('<Unknown foo="bar" />')).not.toThrow()
		expect(parseHubSidebarBlocks('<Unknown foo="bar" />')).toEqual([])
	})

	it('returns an empty list for an empty body', () => {
		expect(parseHubSidebarBlocks('')).toEqual([])
	})
})
