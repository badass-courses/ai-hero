import {
	extractMarkdownHeadings,
	type MarkdownHeading,
} from '@/utils/extract-markdown-headings'

export interface TocSection {
	slug: string
	text: string
}

/**
 * What the ToC needs to know about a document, and nothing else.
 *
 * Derived on the SERVER and passed down as a prop. It used to be the article's
 * whole markdown body: `PostToCRail` and `PostToCDisclosure` are both client
 * components and both took `markdown`, so a post shipped its source twice in
 * the RSC payload — on top of the compiled MDX tree already in there — and then
 * parsed it twice more during hydration. The model below is a few hundred bytes
 * of slugs and headings regardless of how long the article is.
 *
 * `owners` is a plain array rather than a `Map` so the shape stays obviously
 * serializable; the client scans the document-ordered pairs directly.
 */
export interface TocModel {
	/** The h2s, in document order. The rail lists these and nothing else. */
	sections: TocSection[]
	/**
	 * `[headingSlug, owningH2Slug]` for every heading that sits under an h2, in
	 * document order. h3s are here too — the `Heading` component registers every
	 * heading it renders, so an h3 scrolling past has to mark its parent h2.
	 *
	 * Headings with no owner (an h3 above the first h2) are omitted: the active
	 * -section scan treats an unowned slug as a no-op anyway, so carrying them
	 * would cost payload and change nothing.
	 */
	owners: [string, string][]
}

export function getTocModel(markdown: string): TocModel {
	const sections: TocSection[] = []
	const owners: [string, string][] = []

	const walk = (nodes: MarkdownHeading[], owner: string | null) => {
		for (const node of nodes) {
			let nextOwner = owner
			if (node.level === 2) {
				sections.push({ slug: node.slug, text: node.text })
				nextOwner = node.slug
			}
			if (nextOwner) owners.push([node.slug, nextOwner])
			walk(node.items, nextOwner)
		}
	}

	walk(extractMarkdownHeadings(markdown), null)

	return { sections, owners }
}

/** True when there is nothing for a ToC to list. */
export function isTocModelEmpty(model: TocModel, landmarkCount = 0) {
	return model.sections.length === 0 && landmarkCount === 0
}
