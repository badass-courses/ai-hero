/**
 * Normalizes an authored `<Prerequisites>` block so its shape is hard to get
 * wrong:
 *
 *   <Prerequisites title="Crash Course Prerequisites">
 *     <Prerequisite href="https://www.aihero.dev/workshops/<module>/<lesson>">
 *       Why it matters.
 *     </Prerequisite>
 *   </Prerequisites>
 *
 * MDX wraps text on its own line in a paragraph, and wraps a one-line
 * `<Prerequisite>` in a paragraph too. Both spellings end up the same here:
 * the block's children become its `Prerequisite` elements, and each reason
 * becomes plain inline content. Links inside a reason are reduced to their
 * text, because the block renders each row as one link to the lesson.
 *
 * Pure and synchronous, like `callout-line-autoinsert.ts`; never throws.
 */

type Node = Record<string, any>

/** The block's title when the author gives none. */
export const DEFAULT_PREREQUISITES_TITLE = 'Prerequisites'

const LESSON_URL =
	/^(?:https?:\/\/(?:www\.)?aihero\.dev)?\/workshops\/([^/?#\s]+)\/([^/?#\s]+)\/?(?:[?#]\S*)?$/

export type PrerequisiteLink = { module: string; lesson: string }

/** The module and lesson slugs of an AI Hero lesson URL, or null. */
export function parseLessonUrl(url: unknown): PrerequisiteLink | null {
	if (typeof url !== 'string') return null
	const match = url.trim().match(LESSON_URL)
	if (!match?.[1] || !match[2]) return null
	return { module: match[1], lesson: match[2] }
}

const isElement = (node: Node, name: string) =>
	(node?.type === 'mdxJsxFlowElement' || node?.type === 'mdxJsxTextElement') &&
	node.name === name

/** Inline content only: paragraphs and links give way to their children. */
function inline(nodes: Node[]): Node[] {
	const out: Node[] = []
	for (const node of nodes) {
		if (node.type === 'paragraph') {
			if (out.length > 0) out.push({ type: 'text', value: ' ' })
			out.push(...inline(node.children ?? []))
		} else if (node.type === 'link' || node.type === 'linkReference') {
			out.push(...inline(node.children ?? []))
		} else if (Array.isArray(node.children)) {
			out.push({ ...node, children: inline(node.children) })
		} else {
			out.push(node)
		}
	}
	return out
}

function prerequisitesIn(nodes: Node[]): Node[] {
	return nodes.flatMap((node) =>
		isElement(node, 'Prerequisite')
			? [
					{
						...node,
						type: 'mdxJsxFlowElement',
						children: inline(node.children ?? []),
					},
				]
			: prerequisitesIn(node.children ?? []),
	)
}

function normalize(node: Node) {
	if (!Array.isArray(node?.children)) return
	if (isElement(node, 'Prerequisites')) {
		node.children = prerequisitesIn(node.children)
		return
	}
	node.children.forEach(normalize)
}

export function remarkPrerequisites() {
	return function transformPrerequisites(tree: Node) {
		try {
			normalize(tree)
		} catch {
			// Unexpected tree shape: leave the body as authored.
		}
	}
}
