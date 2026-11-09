import slugify from '@sindresorhus/slugify'

export type MarkdownHeading = {
	level: number
	text: string
	slug: string
	items: MarkdownHeading[]
}

export function slugifyHeading(text: string) {
	return slugify(text, {
		decamelize: false,
		customReplacements: [
			['&', ''],
			['.', ''],
			['/', ''],
		],
	})
}

export function createHeadingSlugger() {
	const slugCounts = new Map<string, number>()
	return (text: string) => {
		const baseSlug = slugifyHeading(text)
		const count = slugCounts.get(baseSlug) ?? 0
		slugCounts.set(baseSlug, count + 1)
		return count === 0 ? baseSlug : `${baseSlug}-${count}`
	}
}

// Components whose content should be skipped during heading extraction
const SKIP_COMPONENTS = ['AISummary'] as const

/**
 * Removes content within specified component tags from markdown
 * @param markdown - The markdown content to process
 * @param componentName - Name of the component to remove content from
 * @returns Markdown with the component content removed
 */
function removeComponentContent(
	markdown: string,
	componentName: string,
): string {
	const regex = new RegExp(
		`<${componentName}[\\s\\S]*?<\\/${componentName}>`,
		'g',
	)
	return markdown.replace(regex, '')
}

/**
 * Removes code blocks from markdown to prevent extracting headings from within them
 * @param markdown - The markdown content to process
 * @returns Markdown with code blocks replaced by empty lines
 */
function removeCodeBlocks(markdown: string): string {
	// Remove fenced code blocks (```...```)
	return markdown.replace(/```[\s\S]*?```/g, '')
}

export const extractMarkdownHeadings = (
	markdown: string,
): MarkdownHeading[] => {
	// Remove content from all components that should be skipped
	let processedMarkdown = SKIP_COMPONENTS.reduce(
		(content, component) => removeComponentContent(content, component),
		markdown,
	)

	// Remove code blocks to prevent extracting headings from within them
	processedMarkdown = removeCodeBlocks(processedMarkdown)

	const headingRegex = /(^#{1,6}) (.+)/gm
	let match
	const stack: MarkdownHeading[] = [{ level: 0, text: '', slug: '', items: [] }] // Initialize stack with a dummy heading
	const nextSlug = createHeadingSlugger()

	while ((match = headingRegex.exec(processedMarkdown)) !== null) {
		const level = match?.[1]?.length
		const text = match?.[2]?.trim()
		if (!level || !text || text.startsWith('!!')) {
			continue
		}
		const heading: MarkdownHeading = {
			level,
			text,
			slug: nextSlug(text),
			items: [],
		}

		// @ts-expect-error
		while (stack.length > 0 && level <= stack[stack.length - 1].level) {
			stack.pop()
		}

		stack[stack.length - 1]?.items.push(heading)
		stack.push(heading)
	}

	return stack[0]?.items ?? []
}

export function flattenMarkdownHeadings(toc: MarkdownHeading[]) {
	return toc.flatMap((h) => [h.slug, ...h.items.flatMap((item) => item.slug)])
}
